import "server-only";

import type { DraftRequest } from "@/lib/domain";
import { resolveMockDraftContext } from "@/lib/server/draft-context/mock.server";
import { createMockDraftGenerator } from "@/lib/server/draft-generator/mock.server";
import type {
  DraftLatestInput,
  DraftLatestResult,
  DraftServiceResult,
} from "./types";

const draftGenerator = createMockDraftGenerator();

export async function generateMockDraft(
  input: DraftRequest,
): Promise<DraftServiceResult> {
  const result = await resolveMockDraftContext(input);
  if (!result.ok) return result;

  return {
    ok: true,
    draft: await draftGenerator.generate(result.ctx),
  };
}

export async function getLatestMockDraft(
  input: DraftLatestInput,
): Promise<DraftLatestResult> {
  if (!input?.personId) {
    return { ok: false, status: 400, error: "Missing fields: personId" };
  }

  return { ok: true, draft: null };
}
