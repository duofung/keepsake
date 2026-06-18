import "server-only";

import { createHmac } from "node:crypto";
import type { DraftRequest } from "@/lib/domain";
import type { MessageDraftSaveInput } from "@/lib/repositories";
import { createDraftRepository } from "@/lib/repositories/drafts.server";
import { currentUserIdOrThrow } from "@/lib/server/auth/current-user.server";
import { resolveDbDraftContextInTx } from "@/lib/server/draft-context/db.server";
import type { DraftContext } from "@/lib/server/draft-generator/types";
import {
  DraftGeneratorError,
  getDraftGenerator,
} from "@/lib/server/draft-generator/index.server";
import { transaction } from "@/lib/server/db/transaction.server";
import type {
  DraftEditInput,
  DraftEditResult,
  DraftLatestInput,
  DraftLatestResult,
  DraftServiceResult,
  DraftVersionsInput,
  DraftVersionsResult,
} from "./types";
import { editMatchesBase, validateDraftEditInput } from "./edit-input";
import { generatorErrorToServiceResult } from "./generator-errors.server";

const PROMPT_HASH_VERSION = "message-drafts-prompt-hmac:v1";

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

export function promptInputHash(
  ctx: DraftContext,
  provider: string,
  modelVersion: string,
): string {
  const input = stableValue({
    version: PROMPT_HASH_VERSION,
    generator: { provider, modelVersion },
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
  draft: import("@/lib/domain").MessageDraft,
  ctx: DraftContext,
  hash: string | null,
  provider: string,
  modelVersion: string,
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
    modelProvider: provider,
    modelVersion,
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
    const ownerId = await currentUserIdOrThrow();
    // Resolve generator outside the transaction so a misconfigured provider
    // fails fast without holding a DB connection.
    const draftGenerator = getDraftGenerator();

    return await transaction(ownerId, async (tx) => {
      const result = await resolveDbDraftContextInTx(ownerId, input, tx);
      if (!result.ok) return result;

      const hash = promptInputHash(
        result.ctx,
        draftGenerator.modelProvider,
        draftGenerator.modelVersion,
      );
      const cached = await draftRepository.findByPromptHash(ownerId, hash, tx);
      if (cached) {
        return { ok: true, draft: cached };
      }

      const generated = await draftGenerator.generate(result.ctx);
      const saved = await draftRepository.save(
        ownerId,
        saveInputFromDraft(
          generated,
          result.ctx,
          hash,
          draftGenerator.modelProvider,
          draftGenerator.modelVersion,
        ),
        tx,
      );

      return { ok: true, draft: saved };
    });
  } catch (error) {
    if (error instanceof DraftGeneratorError) {
      return generatorErrorToServiceResult(error);
    }
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
    const ownerId = await currentUserIdOrThrow();

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

export async function saveDbDraftEdit(
  input: DraftEditInput,
): Promise<DraftEditResult> {
  const invalid = validateDraftEditInput(input);
  if (invalid) return invalid;

  // Defend the parametrised SQL: the `id` column is `uuid` and Postgres will
  // raise a syntax error on bad input. Treat anything that isn't a UUID as
  // "not found" — the same response the route gives for unknown ids.
  if (!UUID_RE.test(input.draftId)) {
    return { ok: false, status: 404, error: "Draft not found" };
  }

  try {
    const ownerId = await currentUserIdOrThrow();

    return await transaction(ownerId, async (tx) => {
      const baseEntry = await draftRepository.getEditBaseById(
        ownerId,
        input.draftId,
        tx,
      );
      if (!baseEntry) {
        return { ok: false, status: 404, error: "Draft not found" };
      }

      const { draft: base, userInstruction, modelProvider, modelVersion } = baseEntry;

      if (editMatchesBase(input, base)) {
        return { ok: true, draft: base };
      }

      const saved = await draftRepository.save(
        ownerId,
        {
          personId: base.personId,
          occasionId: base.occasionId,
          tone: base.tone,
          toneLabel: base.toneLabel,
          alternativeTones: base.alternativeTones,
          subject: input.subject,
          paragraphs: base.paragraphs,
          attachedCard: input.attachedCard,
          quickActions: base.quickActions,
          assistantNote: base.assistantNote,
          // Inherit provenance from the base so the lineage of which
          // generator produced the underlying prose is preserved across
          // user edits. Only the prompt-hash cache key is cleared — see
          // below.
          userInstruction,
          modelProvider: modelProvider ?? undefined,
          modelVersion: modelVersion ?? undefined,
          // User-edited rows are no longer a pure prompt-hash cache product.
          // Clearing the hash keeps prompt-hash lookups from ever returning
          // an edited draft.
          promptHash: null,
        },
        tx,
      );

      return { ok: true, draft: saved };
    });
  } catch (error) {
    console.error(error);
    return {
      ok: false,
      status: 500,
      error: "Draft edit service is unavailable",
    };
  }
}

export async function listDbDraftVersions(
  input: DraftVersionsInput,
): Promise<DraftVersionsResult> {
  const invalid = validateVersionsInput(input);
  if (invalid) return invalid;

  try {
    const ownerId = await currentUserIdOrThrow();
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
