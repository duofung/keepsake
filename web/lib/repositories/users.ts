// UsersRepository — owner identity rows.
//
// Status: minimal P6-B shape — just enough surface for Google sign-in
// to find-or-create on email. Subscription + timezone columns exist on
// the `users` schema row but are deliberately left out of the public
// API here; those land when the product needs them.
//
// Runtime implementation: `users.server.ts`.

import type { ID } from "../domain";
import type { Tx } from "./types";

export interface UserRow {
  readonly id: ID;
  readonly email: string;
  readonly displayName: string | null;
  readonly createdAtISO: string;
}

export interface CreateUserFromGoogleInput {
  readonly email: string;
  readonly displayName: string | null;
}

export interface UsersRepository {
  /**
   * Owner-agnostic email lookup. Used only by the sign-in seam after
   * Google verifies the email. The `users.email` column is `citext` so
   * casing is normalised at the DB layer, but callers should still
   * lowercase before insert as a defensive measure.
   */
  findByEmail(email: string, tx?: Tx): Promise<UserRow | null>;

  /**
   * Insert a new users row with the email + display name a Google id
   * token carried. `subscription_status` and `timezone` keep their
   * schema defaults. Returns the newly created row.
   */
  createFromGoogleProfile(
    input: CreateUserFromGoogleInput,
    tx?: Tx,
  ): Promise<UserRow>;
}
