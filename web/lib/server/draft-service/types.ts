import type { ID, MessageDraft } from "@/lib/domain";

export type DraftServiceResult =
  | { ok: true; draft: MessageDraft }
  | { ok: false; status: 400 | 404 | 500; error: string };

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
