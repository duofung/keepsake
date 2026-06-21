// Pure validation for `PATCH /api/drafts` input. Type-only consumers may
// import this without dragging in the `*.server.ts` modules.
//
// Owner-scoped lookups happen separately in each data-source path. This file
// only catches shape failures — missing fields, wrong types, malformed
// attachedCard, and paragraphs — and produces the route's stable
// `{ ok: false, status, error }` shape.

import type { AttachedCard, DraftParagraph } from "@/lib/domain";
import type { DraftEditInput, DraftEditResult } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAttachedCardShape(value: unknown): value is AttachedCard {
  return (
    isRecord(value)
    && typeof value.styleLabel === "string"
    && typeof value.description === "string"
    && typeof value.paletteHint === "string"
    && typeof value.iconHint === "string"
  );
}

function isDraftParagraphShape(value: unknown): value is DraftParagraph {
  if (!isRecord(value) || typeof value.text !== "string") return false;
  if (value.highlights === undefined) return true;
  return Array.isArray(value.highlights)
    && value.highlights.every((highlight) => typeof highlight === "string");
}

/**
 * Returns `null` when the input is well-formed (caller proceeds), or a
 * `DraftEditResult` 400 to short-circuit the route with.
 */
export function validateDraftEditInput(
  input: DraftEditInput,
): DraftEditResult | null {
  const missing: string[] = [];
  if (!input || typeof input !== "object") {
    return { ok: false, status: 400, error: "Invalid JSON body" };
  }
  if (typeof input.draftId !== "string" || !input.draftId.trim()) {
    missing.push("draftId");
  }
  if (typeof input.subject !== "string") {
    missing.push("subject");
  }
  if (!Array.isArray(input.paragraphs) || !input.paragraphs.every(isDraftParagraphShape)) {
    missing.push("paragraphs");
  }
  // `attachedCard` is either `null` or an object that matches `AttachedCard`.
  // `undefined` is rejected because the route's contract is explicit-or-null.
  if (input.attachedCard !== null && !isAttachedCardShape(input.attachedCard)) {
    missing.push("attachedCard");
  }

  if (missing.length) {
    return {
      ok: false,
      status: 400,
      error: `Missing or invalid fields: ${missing.join(", ")}`,
    };
  }
  return null;
}

function normaliseCard(card: AttachedCard | null): string {
  if (!card) return "null";
  return JSON.stringify({
    styleLabel: card.styleLabel,
    description: card.description,
    paletteHint: card.paletteHint,
    iconHint: card.iconHint,
  });
}

function normaliseParagraphs(paragraphs: DraftParagraph[]): string {
  return JSON.stringify(paragraphs.map((paragraph) => ({
    text: paragraph.text,
    highlights: Array.isArray(paragraph.highlights) ? paragraph.highlights : [],
  })));
}

/**
 * True when the user-edited fields exactly match the base draft's
 * already-persisted values. Used by both data-source paths to suppress
 * no-op version inserts.
 */
export function editMatchesBase(
  input: DraftEditInput,
  base: { subject: string; paragraphs: DraftParagraph[]; attachedCard: AttachedCard | null },
): boolean {
  return (
    input.subject === base.subject
    && normaliseParagraphs(input.paragraphs) === normaliseParagraphs(base.paragraphs)
    && normaliseCard(input.attachedCard) === normaliseCard(base.attachedCard)
  );
}
