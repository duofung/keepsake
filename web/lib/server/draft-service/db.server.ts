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
import type { DraftServiceResult } from "./types";

const MODEL_PROVIDER = "mock";
const MODEL_VERSION = "mock-draft-generator:v1";
const PROMPT_HASH_VERSION = "message-drafts-prompt-hmac:v1";

const draftGenerator = createMockDraftGenerator();
const draftRepository = createDraftRepository();

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
