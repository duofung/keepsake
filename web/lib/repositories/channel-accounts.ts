// ChannelAccountRepository — maps a provider-side identity onto a
// Keepsake `owner_id`. Per-user for the link / list / revoke paths;
// worker-only for `findByProviderUser` because webhook ingest has no
// session.
//
// Status: DESIGN ONLY. Interface declaration; no implementation.
//
// Caller mapping (future):
//   findByProviderUser → channel webhook (WhatsApp / Telegram / Slack)
//                        looks up `owner_id` from the provider event
//                        BEFORE running any owner-scoped logic.
//                        NO ownerId arg: the row's own `owner_id` is
//                        the auth proof. NO session fallback.
//   listForOwner        → Profile / account-management UI
//   link                → /api/channels/<provider>/link callback or
//                        a CLI tool; owner-explicit
//   markRevoked         → /api/channels/<provider>/revoke (or admin tool)
//
// Crypto: `displayName` crosses this interface as PLAINTEXT. The
// implementation owns AES-256-GCM envelope encryption against
// `channel_accounts.display_name_enc`. Callers MUST NOT pass already-
// encrypted bytes through the input bag, and MUST NOT inspect the raw
// column directly.

import type {
  ChannelAccount,
  ChannelAccountId,
  ChannelAccountLinkInput,
  ChannelProvider,
  OwnerId,
  Tx,
} from "./types";

export interface ChannelAccountRepository {
  // ── Worker / webhook (no ownerId) ─────────────────────────────────────

  /**
   * Webhook ingest hands us `(provider, externalUserId)`. Returns the
   * matched account when the link exists, `null` when there is no row.
   *
   * Implementations MUST:
   *   - run under a BYPASSRLS worker role — the webhook has no
   *     `app.user_id`, so RLS-gated SELECTs would return zero rows;
   *   - use the unique `channel_accounts_provider_user_idx` index;
   *   - decrypt `display_name_enc` before returning.
   *
   * Callers (the webhook route) MUST:
   *   - treat a `null` result as "no linked account — respond with a
   *     link prompt"; they MUST NOT fall back to a Keepsake web
   *     session or the `DEV_OWNER_*` env. Channel identity is not auth.
   */
  findByProviderUser(
    provider: ChannelProvider,
    externalUserId: string,
    tx?: Tx,
  ): Promise<ChannelAccount | null>;

  // ── User-scoped ───────────────────────────────────────────────────────

  /**
   * "Which providers has this owner linked?" — Profile / account-
   * management UI. Returns active + revoked rows so the UI can render
   * a Reconnect CTA next to revoked entries.
   */
  listForOwner(ownerId: OwnerId, tx?: Tx): Promise<ChannelAccount[]>;

  /**
   * Idempotent. If `(provider, externalUserId)` already maps to the
   * same `ownerId` the implementation MAY refresh `display_name_enc`,
   * `raw_profile`, and `last_seen_at` and return the existing row.
   * If it maps to a DIFFERENT owner, implementations MUST raise
   * a conflict error rather than silently rebinding — channel
   * identity changes are a deliberate admin action.
   */
  link(
    ownerId: OwnerId,
    input: ChannelAccountLinkInput,
    tx?: Tx,
  ): Promise<ChannelAccount>;

  /**
   * Mark an account `revoked` without deleting the row — we keep the
   * link so we can show it as Reconnect-able in the UI, and so an
   * incoming event from a revoked link can be answered with a
   * "you've disconnected this channel" response rather than the
   * generic link prompt.
   */
  markRevoked(
    ownerId: OwnerId,
    accountId: ChannelAccountId,
    tx?: Tx,
  ): Promise<void>;
}
