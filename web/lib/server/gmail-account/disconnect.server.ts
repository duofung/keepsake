import "server-only";

import type { OwnerId } from "@/lib/repositories";
import { createGmailAccountRepository } from "@/lib/repositories/gmail-accounts.server";
import { dataSource } from "@/lib/server/auth/current-user.server";
import { transaction } from "@/lib/server/db/transaction.server";

export interface GmailDisconnectResult {
  /** Absolute URL the route should redirect the user back to. */
  readonly redirectTo: string;
}

/**
 * Disconnect the caller's primary Gmail account.
 *
 * - Idempotent: if no primary row exists (mock mode, or the row was already
 *   removed elsewhere) the helper returns success rather than 404. The UI
 *   should be able to submit the form even when sender state has drifted.
 * - Repo-only write boundary: SQL lives inside `GmailAccountRepository.disconnect`.
 *   This helper never touches `query()` directly.
 * - Mock mode short-circuits before opening a transaction so dev work without
 *   a database does not crash on disconnect.
 * - Misconfigured `KEEPSAKE_DATA_SOURCE` throws `AuthError("misconfigured")`
 *   through the shared `dataSource()` from the auth seam — the disconnect
 *   route maps that to 500, matching `/api/session`. Otherwise a typo would
 *   silently degrade to a no-op success.
 *
 * Token revocation against Google is intentionally out of scope. P2 only
 * removes the local row; the refresh token in Google's records is left to
 * P-future cleanup.
 */
export async function disconnectGmailAccount(
  ownerId: OwnerId,
  origin: string,
): Promise<GmailDisconnectResult> {
  if (dataSource() === "db") {
    const repo = createGmailAccountRepository();
    const primary = await repo.getPrimary(ownerId);
    if (primary) {
      await transaction(ownerId, async (tx) => {
        await repo.disconnect(ownerId, primary.id, tx);
      });
    }
  }

  return { redirectTo: `${origin}/profile` };
}
