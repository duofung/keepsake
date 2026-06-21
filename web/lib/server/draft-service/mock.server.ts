import "server-only";

import type { DraftRequest, MessageDraft } from "@/lib/domain";
import { resolveMockDraftContext } from "@/lib/server/draft-context/mock.server";
import {
  DraftGeneratorError,
  getDraftGenerator,
} from "@/lib/server/draft-generator/index.server";
import { editMatchesBase, validateDraftEditInput } from "./edit-input";
import { generatorErrorToServiceResult } from "./generator-errors.server";
import {
  getMockDraftById,
  getMockLatest,
  getMockProvenanceById,
  listMockVersions,
  recordMockDraft,
} from "./mock-store.server";
import type {
  DraftEditInput,
  DraftEditResult,
  DraftLatestInput,
  DraftLatestResult,
  DraftServiceResult,
  DraftVersionsInput,
  DraftVersionsResult,
} from "./types";

function safeVersionsLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 5;
  return Math.min(10, Math.max(1, Math.trunc(limit)));
}

export async function generateMockDraft(
  input: DraftRequest,
): Promise<DraftServiceResult> {
  const result = await resolveMockDraftContext(input);
  if (!result.ok) return result;

  try {
    const generator = getDraftGenerator();
    const generated = await generator.generate(result.ctx);
    // Surface the draft in the process-local mock store so subsequent
    // PATCH / latest / versions reads can find it. Provenance mirrors
    // what the DB path persists.
    const draft = recordMockDraft(generated, {
      userInstruction: result.ctx.userInstruction,
      modelProvider: generator.modelProvider,
      modelVersion: generator.modelVersion,
    });
    return { ok: true, draft };
  } catch (error) {
    if (error instanceof DraftGeneratorError) {
      return generatorErrorToServiceResult(error);
    }
    console.error(error);
    return { ok: false, status: 500, error: "Draft generator is unavailable" };
  }
}

export async function getLatestMockDraft(
  input: DraftLatestInput,
): Promise<DraftLatestResult> {
  if (!input?.personId) {
    return { ok: false, status: 400, error: "Missing fields: personId" };
  }

  return {
    ok: true,
    draft: getMockLatest(input.personId, input.occasionId ?? null),
  };
}

export async function listMockDraftVersions(
  input: DraftVersionsInput,
): Promise<DraftVersionsResult> {
  if (!input?.personId) {
    return { ok: false, status: 400, error: "Missing fields: personId" };
  }

  return {
    ok: true,
    drafts: listMockVersions(
      input.personId,
      input.occasionId ?? null,
      safeVersionsLimit(input.limit),
    ),
  };
}

export async function saveMockDraftEdit(
  input: DraftEditInput,
): Promise<DraftEditResult> {
  const invalid = validateDraftEditInput(input);
  if (invalid) return invalid;

  const base = getMockDraftById(input.draftId);
  if (!base) {
    return { ok: false, status: 404, error: "Draft not found" };
  }

  if (editMatchesBase(input, base)) {
    return { ok: true, draft: base };
  }

  const edited: MessageDraft = {
    ...base,
    id: `draft-${Date.now()}`,
    subject: input.subject,
    paragraphs: input.paragraphs,
    attachedCard: input.attachedCard,
  };
  // Inherit provenance from the base entry so mock parity with the DB
  // path holds: the lineage of the generator that produced the prose is
  // preserved across user edits.
  const baseProvenance = getMockProvenanceById(base.id) ?? {
    userInstruction: "",
    modelProvider: null,
    modelVersion: null,
  };
  return { ok: true, draft: recordMockDraft(edited, baseProvenance) };
}
