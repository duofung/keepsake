import "server-only";

// Delivery-worker dispatcher. Mirrors the shape of the existing
// delivery-send, draft-service, etc. seams: env switch in `index`, real
// implementation in `db`, no-op in `mock`. There is no separate
// `KEEPSAKE_WORKER_SOURCE` because the worker is meaningless without DB.

import { processNextQueuedEmailDb } from "./db.server";
import { processNextQueuedEmailMock } from "./mock.server";
import type { WorkerResult } from "./types";

export type { WorkerResult };

type WorkerDataSource = "mock" | "db";

function workerDataSource(): WorkerDataSource {
  const source = process.env.KEEPSAKE_DATA_SOURCE ?? "mock";
  if (source === "mock" || source === "db") return source;
  throw new Error("KEEPSAKE_DATA_SOURCE must be either 'mock' or 'db'.");
}

/**
 * Send exactly one queued email delivery and return the outcome. No
 * batching, no draining, no cron. Repeated invocations from the same
 * process are safe — concurrent invocations across processes are safe
 * because the DB path uses SELECT FOR UPDATE SKIP LOCKED plus a status
 * flip to 'sending' inside the claim transaction.
 */
export async function processNextQueuedEmail(): Promise<WorkerResult> {
  return workerDataSource() === "db"
    ? processNextQueuedEmailDb()
    : processNextQueuedEmailMock();
}
