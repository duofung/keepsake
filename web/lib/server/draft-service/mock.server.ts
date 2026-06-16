import "server-only";

import type { DraftRequest } from "@/lib/domain";
import { resolveMockDraftContext } from "@/lib/server/draft-context/mock.server";
import {
  DraftGeneratorError,
  getDraftGenerator,
} from "@/lib/server/draft-generator/index.server";
import type {
  DraftLatestInput,
  DraftLatestResult,
  DraftServiceResult,
  DraftVersionsInput,
  DraftVersionsResult,
} from "./types";
import { generatorErrorToServiceResult } from "./generator-errors.server";

export async function generateMockDraft(
  input: DraftRequest,
): Promise<DraftServiceResult> {
  const result = await resolveMockDraftContext(input);
  if (!result.ok) return result;

  try {
    const generator = getDraftGenerator();
    return { ok: true, draft: await generator.generate(result.ctx) };
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

  return { ok: true, draft: null };
}

export async function listMockDraftVersions(
  input: DraftVersionsInput,
): Promise<DraftVersionsResult> {
  if (!input?.personId) {
    return { ok: false, status: 400, error: "Missing fields: personId" };
  }

  return { ok: true, drafts: [] };
}
