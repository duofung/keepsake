import "server-only";

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import type { OwnerId, Tx } from "@/lib/repositories";

const txClient = Symbol("keepsake.pg.tx.client");
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PgTx = Tx & {
  readonly [txClient]: PoolClient;
};

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to open a database transaction.");
  }

  pool = new Pool({ connectionString });
  return pool;
}

function appUserIdLiteral(ownerId: OwnerId | null): string {
  if (ownerId === null) return "''";

  // Postgres does not bind $1 inside SET LOCAL utility statements, so keep
  // the statement transaction-local and only interpolate validated UUID text.
  const userId = String(ownerId);
  if (!UUID_TEXT.test(userId)) {
    throw new Error("ownerId must be a UUID before it can be assigned to app.user_id.");
  }

  return `'${userId}'`;
}

function createTx(client: PoolClient): Tx {
  const tx = Object.create(null) as PgTx;
  Object.defineProperty(tx, txClient, {
    enumerable: false,
    value: client,
  });
  return tx;
}

function clientFor(tx: Tx): PoolClient {
  const client = (tx as PgTx)[txClient];
  if (!client) {
    throw new Error("Invalid transaction handle.");
  }
  return client;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  tx: Tx,
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  return clientFor(tx).query<T>(text, [...values]);
}

export async function transaction<T>(
  ownerId: OwnerId | null,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const appUserId = appUserIdLiteral(ownerId);
  const client = await getPool().connect();
  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(`SET LOCAL app.user_id = ${appUserId}`);

    const result = await fn(createTx(client));

    await client.query("COMMIT");
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }
}
