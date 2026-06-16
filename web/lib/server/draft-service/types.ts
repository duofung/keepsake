import type { MessageDraft } from "@/lib/domain";

export type DraftServiceResult =
  | { ok: true; draft: MessageDraft }
  | { ok: false; status: 400 | 404 | 500; error: string };
