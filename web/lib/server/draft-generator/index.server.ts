import "server-only";

// Draft generator dispatcher.
//
// `KEEPSAKE_DRAFT_SOURCE` picks which generator backs `/api/drafts`. This is
// deliberately separate from `KEEPSAKE_DATA_SOURCE` (which only decides where
// drafts are PERSISTED) — the four combinations are all valid:
//
//   data=mock + draft=mock   → default local dev
//   data=mock + draft=openai → smoke an LLM without standing up Postgres
//   data=db   + draft=mock   → DB-backed flows, no real LLM bill
//   data=db   + draft=openai → production-shaped path
//
// The dispatcher is lazy: it only loads the configured generator on first
// `getDraftGenerator()` call and caches it for the process lifetime. The
// LLM generator validates its env at construction time and throws
// `DraftGeneratorError("misconfigured", …)` instead of silently falling
// back to mock.
//
// Tests / runtime overrides can call `__resetDraftGeneratorForTest()` to
// re-read the env (used inside this server only — not exported to clients).

import { createMockDraftGenerator } from "./mock.server";
import {
  DraftGeneratorError,
  createOpenAIDraftGenerator,
} from "./openai.server";
import type { DraftGenerator } from "./types";

export { DraftGeneratorError };
export type { DraftGenerator };

export type DraftGeneratorSource = "mock" | "openai";

let cachedGenerator: DraftGenerator | null = null;
let cachedSource: DraftGeneratorSource | null = null;

function readSource(): DraftGeneratorSource {
  const raw = (process.env.KEEPSAKE_DRAFT_SOURCE ?? "mock").trim();
  if (raw === "mock" || raw === "openai") return raw;
  throw new DraftGeneratorError(
    "misconfigured",
    "KEEPSAKE_DRAFT_SOURCE must be either 'mock' or 'openai'.",
  );
}

export function getDraftGenerator(): DraftGenerator {
  const source = readSource();
  if (cachedGenerator && cachedSource === source) return cachedGenerator;

  const generator = source === "openai"
    ? createOpenAIDraftGenerator()
    : createMockDraftGenerator();

  cachedGenerator = generator;
  cachedSource = source;
  return generator;
}

export function draftGeneratorSource(): DraftGeneratorSource {
  return readSource();
}
