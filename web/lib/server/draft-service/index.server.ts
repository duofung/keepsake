import "server-only";

import type { DraftRequest } from "@/lib/domain";
import { generateDbDraft, getLatestDbDraft } from "./db.server";
import { generateMockDraft, getLatestMockDraft } from "./mock.server";
import type {
  DraftLatestInput,
  DraftLatestResult,
  DraftServiceResult,
} from "./types";

type DraftDataSource = "mock" | "db";

function draftDataSource(): DraftDataSource {
  const source = process.env.KEEPSAKE_DATA_SOURCE ?? "mock";
  if (source === "mock" || source === "db") return source;

  throw new Error("KEEPSAKE_DATA_SOURCE must be either 'mock' or 'db'.");
}

export async function generateDraft(
  input: DraftRequest,
): Promise<DraftServiceResult> {
  return draftDataSource() === "db"
    ? generateDbDraft(input)
    : generateMockDraft(input);
}

export async function getLatestDraft(
  input: DraftLatestInput,
): Promise<DraftLatestResult> {
  return draftDataSource() === "db"
    ? getLatestDbDraft(input)
    : getLatestMockDraft(input);
}

export type { DraftLatestInput, DraftLatestResult, DraftServiceResult };
