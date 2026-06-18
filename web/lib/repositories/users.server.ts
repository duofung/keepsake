import "server-only";

import type { QueryResultRow } from "pg";
import { query, workerTransaction } from "@/lib/server/db/transaction.server";
import type {
  CreateUserFromGoogleInput,
  UserRow,
  UsersRepository,
} from "./users";
import type { Tx } from "./types";

type UserDbRow = QueryResultRow & {
  id: string;
  email: string;
  display_name: string | null;
  created_at_iso: string;
};

const USER_SELECT = `
  SELECT
    id::text,
    email::text,
    display_name,
    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_iso
  FROM users
`;

function fromRow(row: UserDbRow): UserRow {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAtISO: row.created_at_iso,
  };
}

async function withTx<T>(
  tx: Tx | undefined,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  // Users is the only repository that needs cross-owner reach: the
  // sign-in flow has to discover whether a brand-new email already
  // owns an account before we know whose `app.user_id` to set.
  // Reuse the worker transaction (no `app.user_id`, must run under a
  // BYPASSRLS connection) for that.
  return tx ? fn(tx) : workerTransaction(fn);
}

export class PgUsersRepository implements UsersRepository {
  async findByEmail(email: string, tx?: Tx): Promise<UserRow | null> {
    return withTx(tx, async (activeTx) => {
      const result = await query<UserDbRow>(
        activeTx,
        `${USER_SELECT} WHERE email = $1 LIMIT 1`,
        [email],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : null;
    });
  }

  async createFromGoogleProfile(
    input: CreateUserFromGoogleInput,
    tx?: Tx,
  ): Promise<UserRow> {
    return withTx(tx, async (activeTx) => {
      const result = await query<UserDbRow>(
        activeTx,
        `
          INSERT INTO users (email, display_name)
          VALUES ($1, $2)
          RETURNING
            id::text,
            email::text,
            display_name,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_iso
        `,
        [input.email, input.displayName],
      );
      return fromRow(result.rows[0]);
    });
  }
}

export function createUsersRepository(): UsersRepository {
  return new PgUsersRepository();
}
