import "server-only";

// Profile-facing read + mutation seam for `channel_accounts` (P8-F).
//
// The Profile page reads `getProfileChannelAccounts()` to render the
// owner's linked command channels. The POST routes
// `/api/channels/{mock,telegram}/link` and
// `/api/channels/{mock,telegram}/revoke` delegate to
// `linkMockChannelAccount()` / `linkTelegramChannelAccount()` /
// `revokeChannelAccount()` here. The
// seam:
//
//   - gates everything on `KEEPSAKE_DATA_SOURCE=db` (mock mode short-
//     circuits to an empty list / 501 errors so the UI doesn't fake
//     a connected state),
//   - identifies the caller via `currentUserIdOrThrow()` (cookie-first
//     + DEV_OWNER_* env fallback) — channel identity is NOT the auth
//     vector here; that's the inbound webhook's job. No sessionless
//     mutation is possible: a missing cookie + missing env throws
//     `AuthError("unauthenticated")` BEFORE any DB call,
//   - is read/write only on the link metadata — it NEVER creates a
//     draft, enqueues a delivery, calls Gmail, or talks to a real
//     provider (this is dev/mock provisioning only).
//
// Transaction model per method:
//   - `getProfileChannelAccounts` (list)  → `transaction(ownerId, …)`,
//     i.e. the request-path pool under RLS. owner_id is filtered both
//     by the policy and by `listForOwner`'s explicit `WHERE owner_id
//     = $1`.
//   - `revokeChannelAccount`              → `transaction(ownerId, …)`,
//     same shape. RLS hides cross-owner rows; `markRevoked` also
//     explicitly enforces `owner_id = $caller` in the UPDATE.
//   - `link{Provider}ChannelAccount`      → does NOT open its own
//     transaction. It delegates to `ChannelAccountRepository.link`
//     whose runtime intentionally elevates to `workerTransaction`
//     (BYPASSRLS) so it can detect cross-owner conflicts on the
//     unique `(provider, external_user_id)` index atomically. The
//     repo enforces the caller's `owner_id` in SQL with
//     `ON CONFLICT … DO UPDATE … WHERE channel_accounts.owner_id =
//     $caller`. The seam still resolves the current user FIRST
//     (`currentUserIdOrThrow`) — no sessionless link path exists.

import type {
  ChannelAccount,
  ChannelAccountId,
  ChannelAccountStatus,
  ChannelProvider,
  OwnerId,
} from "@/lib/repositories";
import { createChannelAccountRepository } from "@/lib/repositories/channel-accounts.server";
import {
  AuthError,
  currentUserIdOrThrow,
  dataSource,
} from "@/lib/server/auth/current-user.server";
import {
  createTelegramStartLinkForOwner,
  type TelegramStartLinkView,
} from "@/lib/server/channels/telegram-start-token.server";
import { transaction } from "@/lib/server/db/transaction.server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const channelAccountRepository = createChannelAccountRepository();

export interface ProfileChannelAccount {
  readonly id: string;
  readonly provider: ChannelProvider;
  readonly externalUserId: string;
  readonly externalThreadId: string | null;
  readonly displayName: string | null;
  readonly status: ChannelAccountStatus;
  readonly createdAtISO: string;
  readonly lastSeenAtISO: string | null;
}

export interface ProfileChannelAccountsView {
  readonly dataSource: "mock" | "db";
  readonly accounts: readonly ProfileChannelAccount[];
  readonly telegramStartLink: TelegramStartLinkView | null;
}

/**
 * List the caller's linked `channel_accounts` for the Profile page.
 *
 * - Mock mode → `{ dataSource: "mock", accounts: [] }`. The UI uses
 *   this to render a "DB mode required" placeholder; we deliberately
 *   don't fabricate fake rows.
 * - DB mode  → cookie-first owner resolution + owner-scoped repo read.
 *
 * `AuthError` propagates so the page wrapper can decide how to render.
 */
export async function getProfileChannelAccounts(): Promise<ProfileChannelAccountsView> {
  if (dataSource() !== "db") {
    return { dataSource: "mock", accounts: [], telegramStartLink: null };
  }
  const ownerId = await currentUserIdOrThrow();
  const accounts = await transaction(ownerId, (tx) =>
    channelAccountRepository.listForOwner(ownerId, tx),
  );
  return {
    dataSource: "db",
    accounts: accounts.map(toProfileChannelAccount),
    telegramStartLink: createTelegramStartLinkForOwner(ownerId),
  };
}

export interface ProfileChannelLinkInput {
  readonly externalUserId: unknown;
  readonly externalThreadId?: unknown;
  readonly displayName?: unknown;
}

export type ProfileChannelLinkResult =
  | { readonly ok: true; readonly account: ProfileChannelAccount }
  | {
      readonly ok: false;
      readonly status: 400 | 409 | 500 | 501;
      readonly code: string;
      readonly detail?: string;
    };

/**
 * Link a mock `(provider="mock", externalUserId)` to the caller's owner_id.
 * The repo's `link()` upserts on `(provider, external_user_id)` so a re-link
 * from the same owner is idempotent — it just flips a previously revoked row
 * back to `active` and refreshes the optional fields.
 */
export async function linkMockChannelAccount(
  input: ProfileChannelLinkInput,
): Promise<ProfileChannelLinkResult> {
  return linkProfileChannelAccount("mock", input);
}

/**
 * Link a Telegram `(provider="telegram", externalUserId)` to the caller's
 * owner_id. This is still a manual/operator UX: the user pastes their
 * Telegram numeric user id. A later `/start <token>` handshake can land next
 * to this without changing the Profile read shape or inbound adapter.
 */
export async function linkTelegramChannelAccount(
  input: ProfileChannelLinkInput,
): Promise<ProfileChannelLinkResult> {
  return linkProfileChannelAccount("telegram", input);
}

async function linkProfileChannelAccount(
  provider: Extract<ChannelProvider, "mock" | "telegram">,
  input: ProfileChannelLinkInput,
): Promise<ProfileChannelLinkResult> {
  if (dataSource() !== "db") {
    return {
      ok: false,
      status: 501,
      code: "not_configured",
      detail: "Channel account linking requires KEEPSAKE_DATA_SOURCE=db.",
    };
  }

  const externalUserId = trimmedString(input.externalUserId);
  if (!externalUserId) {
    return {
      ok: false,
      status: 400,
      code: "invalid_request",
      detail: "externalUserId is required",
    };
  }
  const externalThreadId = trimmedString(input.externalThreadId);
  const displayName = trimmedString(input.displayName);

  const ownerId = await currentUserIdOrThrow();

  try {
    const account = await channelAccountRepository.link(ownerId, {
      provider,
      externalUserId,
      externalThreadId: externalThreadId ?? undefined,
      displayName: displayName ?? null,
    });
    return { ok: true, account: toProfileChannelAccount(account) };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    // Cross-owner conflict: another owner already linked this
    // externalUserId. The repo throws a `cross_owner_conflict`-tagged
    // error; we surface 409 so the caller can tell it apart from a
    // generic 500. The original owner's row stays untouched (see
    // PgChannelAccountRepository.link contract).
    if (/cross_owner_conflict/i.test(message)) {
      return {
        ok: false,
        status: 409,
        code: "cross_owner_conflict",
        detail:
          `That ${provider} identity is already linked to a different Keepsake account.`,
      };
    }
    // Unexpected branch. Log the raw cause for operators but do NOT
    // leak it through the route — clients get a generic detail.
    console.error("linkProfileChannelAccount unexpected failure:", error);
    return {
      ok: false,
      status: 500,
      code: "link_failed",
      detail: `Could not link ${provider} channel account.`,
    };
  }
}

export interface ProfileChannelRevokeInput {
  readonly accountId: unknown;
}

export type ProfileChannelRevokeResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: 400 | 404 | 500 | 501;
      readonly code: string;
      readonly detail?: string;
    };

/**
 * Revoke a linked channel account the caller owns. Cross-owner /
 * unknown ids surface as 404 — the repo's `markRevoked` already
 * throws "not found" in those cases (RLS hides the row under the
 * owner-scoped tx).
 */
export async function revokeChannelAccount(
  input: ProfileChannelRevokeInput,
): Promise<ProfileChannelRevokeResult> {
  if (dataSource() !== "db") {
    return {
      ok: false,
      status: 501,
      code: "not_configured",
      detail: "Channel account revocation requires KEEPSAKE_DATA_SOURCE=db.",
    };
  }

  const accountId = trimmedString(input.accountId);
  if (!accountId || !UUID_RE.test(accountId)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_request",
      detail: "accountId must be a uuid",
    };
  }

  const ownerId = await currentUserIdOrThrow();

  try {
    await channelAccountRepository.markRevoked(
      ownerId,
      accountId as ChannelAccountId,
    );
    return { ok: true };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/not\s+found/i.test(message)) {
      return { ok: false, status: 404, code: "not_found" };
    }
    // Unexpected branch. Log the raw cause for operators but do NOT
    // leak it through the route — clients get a generic detail.
    console.error("revokeChannelAccount unexpected failure:", error);
    return {
      ok: false,
      status: 500,
      code: "revoke_failed",
      detail: "Could not revoke mock channel account.",
    };
  }
}

function toProfileChannelAccount(
  account: ChannelAccount,
): ProfileChannelAccount {
  return {
    id: account.id,
    provider: account.provider,
    externalUserId: account.externalUserId,
    externalThreadId: account.externalThreadId,
    displayName: account.displayName,
    status: account.status,
    createdAtISO: account.createdAtISO,
    lastSeenAtISO: account.lastSeenAtISO,
  };
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// Re-export so route handlers can map AuthError without a separate
// import path.
export { AuthError } from "@/lib/server/auth/current-user.server";

// Owner-id type kept available so future seams in this directory can
// stay TypeScript-typed without re-importing from repositories.
export type { OwnerId };
