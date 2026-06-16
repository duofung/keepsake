import type { AttachedCard, ID, MessageDraft } from "@/lib/domain";

export type DraftServiceResult =
  | { ok: true; draft: MessageDraft }
  | { ok: false; status: 400 | 404 | 500; error: string };

/**
 * `PATCH /api/drafts` request shape — the minimum a user can edit in
 * Workspace today: the subject line and whether a card is attached. tone,
 * paragraphs, quickActions, assistantNote are NOT part of this surface;
 * they continue to be authored server-side by the draft generator.
 */
export interface DraftEditInput {
  draftId: ID;
  subject: string;
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
