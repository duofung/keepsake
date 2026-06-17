// GmailAccountRepository — Gmail sender account storage.
//
// Runtime implementation: gmail-accounts.server.ts.
//
// Caller mapping:
//   getPrimary       → future currentUserOrThrow() sendingAccount hydration
//   upsertPrimary    → future Gmail OAuth callback after token exchange
//   markExpired      → future token refresh/send failure path
//   disconnect       → future Profile "Disconnect Gmail" action
//
// This repository never sends mail. It only stores account state and encrypted
// provider capability tokens.

import type { ID } from "../domain";
import type {
  GmailAccount,
  GmailAccountMarkExpiredInput,
  GmailAccountStatus,
  GmailAccountUpsertInput,
  OwnerId,
  Tx,
} from "./types";

export interface SendingCredentials {
  readonly accountId: ID;
  readonly email: string;
  readonly status: GmailAccountStatus;
  /** Plaintext refresh token. NEVER return this to a route handler. */
  readonly refreshToken: string;
}

export interface GmailAccountRepository {
  /**
   * Primary sender account for the owner. Null means Profile/Workspace should
   * render "not connected" and CurrentUser.sendingAccount remains null.
   */
  getPrimary(ownerId: OwnerId, tx?: Tx): Promise<GmailAccount | null>;

  /**
   * Primary sender account WITH the decrypted refresh token. Worker-only
   * call site — never expose the return value past the send seam.
   */
  getSendingCredentials(
    ownerId: OwnerId,
    tx?: Tx,
  ): Promise<SendingCredentials | null>;

  /**
   * Upsert the owner's primary Gmail account after OAuth succeeds. The refresh
   * token is plaintext at the boundary and must be encrypted by the runtime
   * implementation before insert/update.
   */
  upsertPrimary(
    ownerId: OwnerId,
    input: GmailAccountUpsertInput,
    tx?: Tx,
  ): Promise<GmailAccount>;

  /**
   * Mark the account unusable when token refresh or provider checks fail.
   * Implementations must not delete the row; keeping status enables UI repair.
   */
  markExpired(
    ownerId: OwnerId,
    accountId: ID,
    input: GmailAccountMarkExpiredInput,
    tx?: Tx,
  ): Promise<GmailAccount>;

  /**
   * User-initiated disconnect. Implementations may delete the row or mark it
   * expired/revoked later, but the public result is that getPrimary() returns
   * null for CurrentUser.sendingAccount.
   */
  disconnect(ownerId: OwnerId, accountId: ID, tx?: Tx): Promise<void>;
}
