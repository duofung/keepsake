import type { AttachedCard, DraftParagraph, ID, MessageDraft } from "@/lib/domain";

export type DraftServiceResult =
  | { ok: true; draft: MessageDraft }
  | { ok: false; status: 400 | 404 | 500; error: string };

/**
 * `PATCH /api/drafts` request shape — the user-editable compose fields in
 * Workspace today: subject, body paragraphs, and the optional card design.
 * tone, quickActions, assistantNote are NOT part of this surface; they
 * continue to be authored server-side by the draft generator.
 */
export interface DraftEditInput {
  draftId: ID;
  subject: string;
  paragraphs: DraftParagraph[];
  attachedCard: AttachedCard | null;
}

export type DraftEditResult = DraftServiceResult;

export interface DraftLatestInput {
  personId: ID;
  occasionId?: ID | null;
}

export type DraftLatestResult =
  | { ok: true; draft: MessageDraft | null }
  | { ok: false; status: 400 | 404 | 500; error: string };

export interface DraftVersionsInput {
  personId: ID;
  occasionId?: ID | null;
  limit?: number;
}

export type DraftVersionsResult =
  | { ok: true; drafts: MessageDraft[] }
  | { ok: false; status: 400 | 404 | 500; error: string };
