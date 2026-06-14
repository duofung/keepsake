// DraftRepository — persistence + cache lookup for `message_drafts`.
//
// Status: DESIGN ONLY. Interface declaration; no implementation.
//
// The LLM call itself is NOT here. The eventual `DraftGenerator` produces a
// MessageDraft from a hydrated person + relationship + culture + occasion,
// and this repo persists the result. Today the mock generator in
// `app/api/drafts/route.ts` plays the generator role; the repo will be the
// last piece to land before the real LLM swap.
//
// Caller mapping:
//   findByPromptHash   → /api/drafts POST (cache lookup before generator)
//   getLatestFor       → future workspace reload — pick up where the user left off
//   save               → /api/drafts POST (after generator)
//   listForPerson      → future "draft history" (post-MVP)

import type { ID, MessageDraft } from "../domain";
import type { MessageDraftSaveInput, OwnerId, Tx } from "./types";

export interface DraftRepository {
  /**
   * Cache lookup. The hash should include the resolved catalog rows
   * (relationship, culture) so editing a culture's taboos invalidates old
   * drafts naturally. See `repositories/README.md` for the contract.
   */
  findByPromptHash(
    ownerId: OwnerId,
    promptHash: string,
    tx?: Tx,
  ): Promise<MessageDraft | null>;

  /**
   * Most recent draft for a person + occasion pair. Used to restore the
   * Workspace state when the user navigates back to a person they were
   * already writing to.
   */
  getLatestFor(
    ownerId: OwnerId,
    personId: ID,
    occasionId: ID | null,
    tx?: Tx,
  ): Promise<MessageDraft | null>;

  /** Persist a fully-formed draft and return the row with server-assigned id. */
  save(
    ownerId: OwnerId,
    input: MessageDraftSaveInput,
    tx?: Tx,
  ): Promise<MessageDraft>;

  /** Past drafts for a person, newest first. Post-MVP, behind a feature flag. */
  listForPerson(
    ownerId: OwnerId,
    personId: ID,
    limit: number,
    tx?: Tx,
  ): Promise<MessageDraft[]>;
}
