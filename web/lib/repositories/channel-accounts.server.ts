import "server-only";

import type { QueryResultRow } from "pg";
import { decrypt, encrypt } from "@/lib/server/crypto/envelope.server";
import {
  query,
  transaction,
  workerTransaction,
} from "@/lib/server/db/transaction.server";
import type { ChannelAccountRepository } from "./channel-accounts";
import type {
  ChannelAccount,
  ChannelAccountId,
  ChannelAccountLinkInput,
  ChannelAccountStatus,
  ChannelProvider,
  OwnerId,
  Tx,
} from "./types";

const TABLE = "channel_accounts";
const DISPLAY_NAME_COLUMN = "display_name_enc";

type ChannelAccountRow = QueryResultRow & {
  id: string;
  owner_id: string;
  provider: ChannelProvider;
  external_user_id: string;
  external_thread_id: string | null;
  display_name_enc: Uint8Array | null;
  status: ChannelAccountStatus;
  raw_profile: unknown;
  created_at_iso: string;
  updated_at_iso: string;
  last_seen_at_iso: string | null;
};

const ACCOUNT_SELECT = `
  SELECT
    id::text,
    owner_id::text,
    provider,
    external_user_id,
    external_thread_id,
    display_name_enc,
    status,
    raw_profile,
    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_iso,
    to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_iso,
    to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_seen_at_iso
  FROM channel_accounts
`;

async function withTx<T>(
  ownerId: OwnerId,
  tx: Tx | undefined,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return tx ? fn(tx) : transaction(ownerId, fn);
}

async function encryptDisplayName(
  ownerId: OwnerId,
  plaintext: string,
): Promise<Buffer> {
  const bytes = await encrypt(
    ownerId,
    TABLE,
    DISPLAY_NAME_COLUMN,
    Buffer.from(plaintext, "utf8"),
  );
  return Buffer.from(bytes);
}

async function decryptDisplayName(
  ownerId: OwnerId,
  cipher: Uint8Array,
): Promise<string> {
  const bytes = await decrypt(ownerId, TABLE, DISPLAY_NAME_COLUMN, cipher);
  return Buffer.from(bytes).toString("utf8");
}

async function accountFromRow(row: ChannelAccountRow): Promise<ChannelAccount> {
  const ownerId = row.owner_id as OwnerId;
  const displayName = row.display_name_enc
    ? await decryptDisplayName(ownerId, row.display_name_enc)
    : null;
  const rawProfile =
    row.raw_profile && typeof row.raw_profile === "object"
      ? (row.raw_profile as Record<string, unknown>)
      : {};
  return {
    id: row.id as ChannelAccountId,
    ownerId,
    provider: row.provider,
    externalUserId: row.external_user_id,
    externalThreadId: row.external_thread_id,
    displayName,
    status: row.status,
    rawProfile,
    createdAtISO: row.created_at_iso,
    updatedAtISO: row.updated_at_iso,
    lastSeenAtISO: row.last_seen_at_iso,
  };
}

export class PgChannelAccountRepository implements ChannelAccountRepository {
  async findByProviderUser(
    provider: ChannelProvider,
    externalUserId: string,
    tx?: Tx,
  ): Promise<ChannelAccount | null> {
    // Webhook ingest call site. No ownerId arg by design — the row's
    // own `owner_id` is the auth proof. Worker/webhook tx must be
    // BYPASSRLS (no SET LOCAL app.user_id), so we require an explicit
    // tx and refuse to open one ourselves: a transaction(ownerId, …)
    // would be silently wrong here.
    if (!tx) {
      throw new Error(
        "ChannelAccountRepository.findByProviderUser must be called inside a worker / webhook tx.",
      );
    }
    const result = await query<ChannelAccountRow>(
      tx,
      `${ACCOUNT_SELECT}
       WHERE provider = $1::channel_provider
         AND external_user_id = $2
       LIMIT 1`,
      [provider, externalUserId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return accountFromRow(row);
  }

  async listForOwner(ownerId: OwnerId, tx?: Tx): Promise<ChannelAccount[]> {
    return withTx(ownerId, tx, async (activeTx) => {
      const result = await query<ChannelAccountRow>(
        activeTx,
        `${ACCOUNT_SELECT}
         WHERE owner_id = $1
         ORDER BY provider ASC, created_at ASC, id ASC`,
        [ownerId],
      );
      return Promise.all(result.rows.map(accountFromRow));
    });
  }

  async link(
    ownerId: OwnerId,
    input: ChannelAccountLinkInput,
    tx?: Tx,
  ): Promise<ChannelAccount> {
    const displayNameEnc =
      input.displayName !== undefined && input.displayName !== null
        ? await encryptDisplayName(ownerId, input.displayName)
        : null;
    const rawProfile = input.rawProfile ?? {};
    const externalThreadId = input.externalThreadId ?? null;

    // We need to detect cross-owner conflicts atomically. An
    // owner-scoped `transaction(ownerId, …)` would have its
    // UPDATE-on-conflict filtered by RLS WITH CHECK, leaking as a
    // generic permission error. We elevate to `workerTransaction`
    // (BYPASSRLS) and enforce owner_id manually in the
    // ON CONFLICT … DO UPDATE … WHERE clause.
    const runner: (fn: (tx: Tx) => Promise<ChannelAccount>) => Promise<ChannelAccount> =
      tx ? (fn) => fn(tx) : workerTransaction;

    return runner(async (activeTx) => {
      const result = await query<ChannelAccountRow>(
        activeTx,
        `
          INSERT INTO channel_accounts (
            owner_id,
            provider,
            external_user_id,
            external_thread_id,
            display_name_enc,
            status,
            raw_profile,
            last_seen_at
          )
          VALUES (
            $1::uuid,
            $2::channel_provider,
            $3,
            $4,
            $5,
            'active'::channel_account_status,
            $6::jsonb,
            now()
          )
          ON CONFLICT (provider, external_user_id) DO UPDATE
          SET
            external_thread_id = EXCLUDED.external_thread_id,
            display_name_enc   = EXCLUDED.display_name_enc,
            status             = 'active'::channel_account_status,
            raw_profile        = EXCLUDED.raw_profile,
            last_seen_at       = now(),
            updated_at         = now()
          WHERE channel_accounts.owner_id = $1::uuid
          RETURNING
            id::text,
            owner_id::text,
            provider,
            external_user_id,
            external_thread_id,
            display_name_enc,
            status,
            raw_profile,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_iso,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_iso,
            to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_seen_at_iso
        `,
        [
          ownerId,
          input.provider,
          input.externalUserId,
          externalThreadId,
          displayNameEnc,
          JSON.stringify(rawProfile),
        ],
      );

      const row = result.rows[0];
      if (row) return accountFromRow(row);

      // ON CONFLICT … DO UPDATE's WHERE didn't match → the existing
      // row belongs to a DIFFERENT owner. Don't silently rebind —
      // emit a stable, recognisable error so callers (and tests) can
      // gate on it.
      throw new Error(
        `ChannelAccountRepository.link: cross_owner_conflict — ` +
          `(provider=${input.provider}, externalUserId=${input.externalUserId}) ` +
          `is already linked to a different owner`,
      );
    });
  }

  async markRevoked(
    ownerId: OwnerId,
    accountId: ChannelAccountId,
    tx?: Tx,
  ): Promise<void> {
    await withTx(ownerId, tx, async (activeTx) => {
      const result = await query<{ id: string }>(
        activeTx,
        `
          UPDATE channel_accounts
          SET status     = 'revoked'::channel_account_status,
              updated_at = now()
          WHERE id = $1::uuid
            AND owner_id = $2::uuid
          RETURNING id::text
        `,
        [accountId, ownerId],
      );
      if (!result.rows[0]) {
        // Unknown id, or owner-mismatch (RLS already hid it under
        // user-scoped tx). Surface as not-found so bugs are loud.
        throw new Error(
          `ChannelAccountRepository.markRevoked target was not found.`,
        );
      }
    });
  }
}

export function createChannelAccountRepository(): ChannelAccountRepository {
  return new PgChannelAccountRepository();
}
