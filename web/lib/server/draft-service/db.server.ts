import "server-only";

import { createHmac } from "node:crypto";
import type { DraftRequest } from "@/lib/domain";
import type { MessageDraftSaveInput } from "@/lib/repositories";
import { createDraftRepository } from "@/lib/repositories/drafts.server";
import { currentUserIdOrThrow } from "@/lib/server/auth/current-user.server";
import { resolveDbDraftContextInTx } from "@/lib/server/draft-context/db.server";
import type { DraftContext } from "@/lib/server/draft-generator/types";
import { createMockDraftGenerator } from "@/lib/server/draft-generator/mock.server";
import { transaction } from "@/lib/server/db/transaction.server";
import type {
  DraftLatestInput,
  DraftLatestResult,
  DraftServiceResult,
  DraftVersionsInput,
  DraftVersionsResult,
} from "./types";

const MODEL_PROVIDER = "mock";
const MODEL_VERSION = "mock-draft-generator:v1";
const PROMPT_HASH_VERSION = "message-drafts-prompt-hmac:v1";

const draftGenerator = createMockDraftGenerator();
const draftRepository = createDraftRepository();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

export function promptInputHash(ctx: DraftContext): string {
  const input = stableValue({
    version: PROMPT_HASH_VERSION,
    generator: {
      provider: MODEL_PROVIDER,
      modelVersion: MODEL_VERSION,
    },
    person: ctx.person,
    relationship: ctx.relationship,
    cultureRule: ctx.cultureRule,
    occasion: ctx.occasion,
    userInstruction: ctx.userInstruction,
  });

  return createHmac("sha256", promptHashKey())
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

function promptHashKey(): Buffer {
  const encoded = process.env.DEV_ENCRYPTION_KEY_BASE64;
  if (!encoded) {
    throw new Error("DEV_ENCRYPTION_KEY_BASE64 is required for draft prompt hashing.");
  }

  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error("DEV_ENCRYPTION_KEY_BASE64 must decode to 32 bytes for draft prompt hashing.");
  }

  return key;
}

function saveInputFromDraft(
  draft: Awaited<ReturnType<typeof draftGenerator.generate>>,
  ctx: DraftContext,
  hash: string,
): MessageDraftSaveInput {
  return {
    personId: draft.personId,
    occasionId: draft.occasionId,
    tone: draft.tone,
    toneLabel: draft.toneLabel,
    alternativeTones: draft.alternativeTones,
    subject: draft.subject,
    paragraphs: draft.paragraphs,
    attachedCard: draft.attachedCard,
    quickActions: draft.quickActions,
    assistantNote: draft.assistantNote,
    userInstruction: ctx.userInstruction,
    promptHash: hash,
    modelProvider: MODEL_PROVIDER,
    modelVersion: MODEL_VERSION,
  };
}

function validateInput(input: DraftRequest): DraftServiceResult | null {
  const missing: string[] = [];
  if (!input?.personId) missing.push("personId");
  if (typeof input?.userInstruction !== "string") missing.push("userInstruction");

  return missing.length
    ? { ok: false, status: 400, error: `Missing fields: ${missing.join(", ")}` }
    : null;
}

function validateLatestInput(input: DraftLatestInput): DraftLatestResult | null {
  if (!input?.personId) {
    return { ok: false, status: 400, error: "Missing fields: personId" };
  }

  return null;
}

function safeVersionsLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 5;
  return Math.min(10, Math.max(1, Math.trunc(limit)));
}

function validateVersionsInput(input: DraftVersionsInput): DraftVersionsResult | null {
  if (!input?.personId) {
    return { ok: false, status: 400, error: "Missing fields: personId" };
  }

  if (!UUID_RE.test(input.personId)) {
    return { ok: false, status: 400, error: "Invalid personId" };
  }

  if (input.occasionId && !UUID_RE.test(input.occasionId)) {
    return { ok: false, status: 404, error: "Occasion not found" };
  }

  return null;
}

export async function generateDbDraft(
  input: DraftRequest,
): Promise<DraftServiceResult> {
  const invalid = validateInput(input);
  if (invalid) return invalid;

  try {
    const ownerId = currentUserIdOrThrow();

    return await transaction(ownerId, async (tx) => {
      const result = await resolveDbDraftContextInTx(ownerId, input, tx);
      if (!result.ok) return result;

      const hash = promptInputHash(result.ctx);
      const cached = await draftRepository.findByPromptHash(ownerId, hash, tx);
      if (cached) {
        return { ok: true, draft: cached };
      }

      const generated = await draftGenerator.generate(result.ctx);
      const saved = await draftRepository.save(
        ownerId,
        saveInputFromDraft(generated, result.ctx, hash),
        tx,
      );

      return { ok: true, draft: saved };
    });
  } catch (error) {
    console.error(error);
    return {
      ok: false,
      status: 500,
      error: "Draft context resolver is unavailable",
    };
  }
}

export async function getLatestDbDraft(
  input: DraftLatestInput,
): Promise<DraftLatestResult> {
  const invalid = validateLatestInput(input);
  if (invalid) return invalid;

  try {
    const ownerId = currentUserIdOrThrow();

    return await transaction(ownerId, async (tx) => {
      const result = await resolveDbDraftContextInTx(
        ownerId,
        {
          personId: input.personId,
          occasionId: input.occasionId ?? null,
          userInstruction: "",
        },
        tx,
      );
      if (!result.ok) return result;

      const latest = await draftRepository.getLatestFor(
        ownerId,
        result.ctx.person.id,
        result.ctx.occasion?.id ?? null,
        tx,
      );

      return { ok: true, draft: latest };
    });
  } catch (error) {
    console.error(error);
    return {
      ok: false,
      status: 500,
      error: "Draft context resolver is unavailable",
    };
  }
}

export async function listDbDraftVersions(
  input: DraftVersionsInput,
): Promise<DraftVersionsResult> {
  const invalid = validateVersionsInput(input);
  if (invalid) return invalid;

  try {
    const ownerId = currentUserIdOrThrow();
    const safeLimit = safeVersionsLimit(input.limit);
    const readLimit = Math.min(30, Math.max(safeLimit * 3, safeLimit));

    return await transaction(ownerId, async (tx) => {
      const result = await resolveDbDraftContextInTx(
        ownerId,
        {
          personId: input.personId,
          occasionId: input.occasionId ?? null,
          userInstruction: "",
        },
        tx,
      );
      if (!result.ok) return result;

      const resolvedOccasionId = result.ctx.occasion?.id ?? null;
      const drafts = await draftRepository.listForPerson(
        ownerId,
        result.ctx.person.id,
        readLimit,
        tx,
      );

      return {
        ok: true,
        drafts: drafts
          .filter((draft) => draft.occasionId === resolvedOccasionId)
          .slice(0, safeLimit),
      };
    });
  } catch (error) {
    console.error(error);
    return {
      ok: false,
      status: 500,
      error: "Draft context resolver is unavailable",
    };
  }
}
