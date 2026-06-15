import "server-only";

import type { DraftRequest } from "@/lib/domain";
import { resolveDbDraftContext } from "./db.server";
import {
  resolveMockDraftContext,
  type DraftContextResolution,
} from "./mock.server";

export type { DraftContextResolution };

type DraftContextDataSource = "mock" | "db";

function draftContextDataSource(): DraftContextDataSource {
  const source = process.env.KEEPSAKE_DATA_SOURCE ?? "mock";
  if (source === "mock" || source === "db") return source;

  throw new Error("KEEPSAKE_DATA_SOURCE must be either 'mock' or 'db'.");
}

export async function resolveDraftContext(
  input: DraftRequest,
): Promise<DraftContextResolution> {
  return draftContextDataSource() === "db"
    ? resolveDbDraftContext(input)
    : resolveMockDraftContext(input);
}
