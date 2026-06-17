import "server-only";

import type { QueryResultRow } from "pg";
import { decrypt, encrypt } from "@/lib/server/crypto/envelope.server";
import { query, transaction } from "@/lib/server/db/transaction.server";
import type { GmailAccountRepository, SendingCredentials } from "./gmail-accounts";
import type {
  GmailAccount,
  GmailAccountMarkExpiredInput,
  GmailAccountStatus,
  GmailAccountUpsertInput,
  OwnerId,
  Tx,
} from "./types";

type GmailAccountRow = QueryResultRow & {
  id: string;
  owner_id: string;
  email: string;
  status: GmailAccountStatus;
  scopes: string[];
  is_primary: boolean;
  last_connected_at_iso: string;
  refresh_token_expires_at_iso: string | null;
  last_error: string | null;
  created_at_iso: string;
  updated_at_iso: string;
};

const TABLE = "gmail_accounts";
const MAX_LAST_ERROR_LENGTH = 2048;

const ACCOUNT_SELECT = `
  SELECT
    id::text,
    owner_id::text,
    email::text,
    status,
    scopes,
    is_primary,
    to_char(last_connected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_connected_at_iso,
    to_char(refresh_token_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS refresh_token_expires_at_iso,
    last_error,
    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_iso,
    to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_iso
  FROM gmail_accounts
`;

async function withTx<T>(
  ownerId: OwnerId,
  tx: Tx | undefined,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return tx ? fn(tx) : transaction(ownerId, fn);
}

async function encryptRefreshToken(
  ownerId: OwnerId,
  refreshToken: string,
): Promise<Buffer> {
  const bytes = await encrypt(
    ownerId,
    TABLE,
    "refresh_token_enc",
    Buffer.from(refreshToken, "utf8"),
  );
  return Buffer.from(bytes);
}

function accountFromRow(row: GmailAccountRow): GmailAccount {
  return {
    id: row.id,
    ownerId: row.owner_id as OwnerId,
    email: row.email,
    status: row.status,
    scopes: row.scopes,
    isPrimary: row.is_primary,
    lastConnectedAtISO: row.last_connected_at_iso,
    refreshTokenExpiresAtISO: row.refresh_token_expires_at_iso,
    lastError: row.last_error,
    createdAtISO: row.created_at_iso,
    updatedAtISO: row.updated_at_iso,
  };
}

function clippedLastError(input: GmailAccountMarkExpiredInput): string | null {
  const value = input.lastError?.trim();
  if (!value) return null;
  return value.slice(0, MAX_LAST_ERROR_LENGTH);
}

function notFound(method: string): never {
  throw new Error(`GmailAccountRepository.${method} target was not found.`);
}

export class PgGmailAccountRepository implements GmailAccountRepository {
  async getSendingCredentials(
    ownerId: OwnerId,
    tx?: Tx,
  ): Promise<SendingCredentials | null> {
    return withTx(ownerId, tx, async (activeTx) => {
      const result = await query<{
        id: string;
        email: string;
        status: GmailAccountStatus;
        refresh_token_enc: Uint8Array;
      } & QueryResultRow>(
        activeTx,
        `
          SELECT
            id::text,
            email::text,
            status,
            refresh_token_enc
          FROM gmail_accounts
          WHERE owner_id = $1
            AND is_primary
          ORDER BY updated_at DESC, id DESC
          LIMIT 1
        `,
        [ownerId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const bytes = await decrypt(
        ownerId,
        TABLE,
        "refresh_token_enc",
        row.refresh_token_enc,
      );
      return {
        accountId: row.id,
        email: row.email,
        status: row.status,
        refreshToken: Buffer.from(bytes).toString("utf8"),
      };
    });
  }

  async getPrimary(ownerId: OwnerId, tx?: Tx): Promise<GmailAccount | null> {
    return withTx(ownerId, tx, async (activeTx) => {
      const result = await query<GmailAccountRow>(
        activeTx,
        `
          ${ACCOUNT_SELECT}
          WHERE owner_id = $1
            AND is_primary
          ORDER BY updated_at DESC, id DESC
          LIMIT 1
        `,
        [ownerId],
      );

      return result.rows[0] ? accountFromRow(result.rows[0]) : null;
    });
  }

  async upsertPrimary(
    ownerId: OwnerId,
    input: GmailAccountUpsertInput,
    tx?: Tx,
  ): Promise<GmailAccount> {
    return withTx(ownerId, tx, async (activeTx) => {
      // Keep the partial unique index `(owner_id) WHERE is_primary` happy when
      // a user connects a different Gmail address.
      await query(
        activeTx,
        `
          UPDATE gmail_accounts
          SET is_primary = false,
              updated_at = now()
          WHERE owner_id = $1
            AND is_primary
        `,
        [ownerId],
      );

      const result = await query<GmailAccountRow>(
        activeTx,
        `
          INSERT INTO gmail_accounts (
            owner_id,
            email,
            status,
            scopes,
            is_primary,
            refresh_token_enc,
            refresh_token_expires_at,
            last_connected_at,
            last_error
          )
          VALUES (
            $1,
            $2,
            'connected',
            $3::text[],
            true,
            $4,
            $5::timestamptz,
            now(),
            NULL
          )
          ON CONFLICT (owner_id, email) DO UPDATE
          SET
            status = 'connected',
            scopes = EXCLUDED.scopes,
            is_primary = true,
            refresh_token_enc = EXCLUDED.refresh_token_enc,
            refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
            last_connected_at = now(),
            last_error = NULL,
            updated_at = now()
          RETURNING
            id::text,
            owner_id::text,
            email::text,
            status,
            scopes,
            is_primary,
            to_char(last_connected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_connected_at_iso,
            to_char(refresh_token_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS refresh_token_expires_at_iso,
            last_error,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_iso,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_iso
        `,
        [
          ownerId,
          input.email,
          input.scopes,
          await encryptRefreshToken(ownerId, input.refreshToken),
          input.refreshTokenExpiresAtISO ?? null,
        ],
      );

      return accountFromRow(result.rows[0]);
    });
  }

  async markExpired(
    ownerId: OwnerId,
    accountId: string,
    input: GmailAccountMarkExpiredInput,
    tx?: Tx,
  ): Promise<GmailAccount> {
    return withTx(ownerId, tx, async (activeTx) => {
      const result = await query<GmailAccountRow>(
        activeTx,
        `
          UPDATE gmail_accounts
          SET status = 'expired',
              last_error = $3,
              updated_at = now()
          WHERE owner_id = $1
            AND id = $2
          RETURNING
            id::text,
            owner_id::text,
            email::text,
            status,
            scopes,
            is_primary,
            to_char(last_connected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_connected_at_iso,
            to_char(refresh_token_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS refresh_token_expires_at_iso,
            last_error,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_iso,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_iso
        `,
        [ownerId, accountId, clippedLastError(input)],
      );

      if (!result.rows[0]) notFound("markExpired");
      return accountFromRow(result.rows[0]);
    });
  }

  async disconnect(ownerId: OwnerId, accountId: string, tx?: Tx): Promise<void> {
    await withTx(ownerId, tx, async (activeTx) => {
      await query(
        activeTx,
        `
          DELETE FROM gmail_accounts
          WHERE owner_id = $1
            AND id = $2
        `,
        [ownerId, accountId],
      );
    });
  }
}

export function createGmailAccountRepository(): GmailAccountRepository {
  return new PgGmailAccountRepository();
}
