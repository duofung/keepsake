import "server-only";

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import type { OwnerId, Tx } from "@/lib/repositories";

const txClient = Symbol("keepsake.pg.tx.client");
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PgTx = Tx & {
  readonly [txClient]: PoolClient;
};

let pool: Pool | null = null;
let workerPool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to open a database transaction.");
  }

  pool = new Pool({ connectionString });
  return pool;
}

function getWorkerPool(): Pool {
  if (workerPool) return workerPool;

  // The worker discovers ownerIds during a queue scan, so it cannot rely on
  // a `SET LOCAL app.user_id`. Its connection role MUST BYPASSRLS (a
  // dedicated worker role in production, the admin/superuser URL in dev
  // and tests). Operators that want to keep request and worker pools on
  // separate roles point this variable at the worker DSN.
  const connectionString =
    process.env.KEEPSAKE_WORKER_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "KEEPSAKE_WORKER_DATABASE_URL or DATABASE_URL is required to open a worker transaction.",
    );
  }

  workerPool = new Pool({ connectionString });
  return workerPool;
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

/**
 * Worker-side transaction. Does NOT set `app.user_id` because the worker
 * discovers ownerIds during a queue scan. The connection role MUST
 * `BYPASSRLS`; in dev/tests that's typically the admin/superuser URL,
 * in production it's a dedicated worker role. Repository queries inside
 * this transaction MUST still scope by `WHERE owner_id = $1` whenever
 * they touch per-owner rows.
 */
export async function workerTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await getWorkerPool().connect();
  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;

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
