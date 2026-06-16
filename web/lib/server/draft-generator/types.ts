// Draft generator types.
//
// Status: design-shaped, but already in use — the mock implementation in
// `mock.server.ts` is the real generator today. When the LLM client lands it
// implements the same `DraftGenerator` interface; the route handler does
// not move.
//
// This file is type-only and safe to import from anywhere. The implementation
// lives in `mock.server.ts` and is bound by Next.js to server-only code paths.

import type {
  AttachedCard,
  CultureRule,
  DraftParagraph,
  DraftQuickAction,
  MessageDraft,
  OccasionNode,
  Person,
  Relationship,
  Tone,
} from "@/lib/domain";

/**
 * Fully-resolved input the generator receives. The route handler is
 * responsible for producing this from a `DraftRequest` — looking up the
 * person, hydrating relationship + culture, and validating the occasion.
 * The generator trusts everything inside.
 */
export interface DraftContext {
  person: Person;
  relationship: Relationship;
  cultureRule: CultureRule;
  occasion: OccasionNode | null;
  userInstruction: string;            // "" → produce the initial draft
}

/**
 * Internal mid-stage shape used by `baseRecipe` / `applyInstruction` in the
 * mock implementation. Lives here so future generator variants can opt into
 * the same intermediate type rather than reinventing it.
 */
export interface Recipe {
  tone: Tone;
  toneLabel: string;
  alternativeTones: { tone: Tone; label: string }[];
  subject: string;
  paragraphs: DraftParagraph[];
  card: AttachedCard | null;
  quickActions: DraftQuickAction[];
}

/**
 * The single seam the route depends on. Either the mock generator or an LLM
 * client implements it; same signature, same return shape. `modelProvider`
 * and `modelVersion` are folded into the prompt-cache hash so swapping
 * providers invalidates cached drafts automatically.
 */
export interface DraftGenerator {
  readonly modelProvider: string;
  readonly modelVersion: string;
  generate(ctx: DraftContext): Promise<MessageDraft>;
}

/**
 * Kinds of failures the dispatcher / LLM adapter raise. The draft-service
 * catches these and maps them to the route's HTTP error contract without
 * leaking provider details to the client.
 */
export type DraftGeneratorErrorKind =
  | "misconfigured"
  | "unavailable"
  | "malformed_response";
