import "server-only";

// Delivery-worker dispatcher + loop wrapper.
//
// `processNextQueuedEmail()` is the single-tick contract from P5-A.
// `recoverStaleSendingDeliveries()` is the recovery seam introduced in
// P5-B: it moves rows stuck in `'sending'` back to `'queued'` so a
// subsequent tick re-attempts them. `runDeliveryWorkerLoop()` is a thin
// driver that calls the recovery seam once (if requested) and then
// invokes `processNextQueuedEmail()` repeatedly until the queue is
// drained / the budget is exhausted / something stops it.
//
// There is no `KEEPSAKE_WORKER_SOURCE`; everything follows the existing
// `KEEPSAKE_DATA_SOURCE` switch. Mock mode is a runnable no-op so the
// manual run script stays smoke-clean in any environment.

import { processNextQueuedEmailDb, recoverStaleSendingDeliveriesDb } from "./db.server";
import {
  WorkerMisconfiguredError,
  assertGmailTransportConfig,
} from "./gmail-transport.server";
import {
  processNextQueuedEmailMock,
  recoverStaleSendingDeliveriesMock,
} from "./mock.server";
import {
  runDeliveryWorkerLoop,
  type DeliveryWorkerLoopOptions,
  type DeliveryWorkerLoopSummary,
} from "./runtime.server";
import type { WorkerResult } from "./types";

export type {
  DeliveryWorkerLoopOptions,
  DeliveryWorkerLoopSummary,
  WorkerResult,
};

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

export interface RecoverStaleOptions {
  readonly staleAfterSeconds: number;
}

/**
 * Recover stuck `'sending'` rows (see `recoverStaleSendingDeliveriesDb`
 * for the duplicate-send caveat). Mock mode is a no-op.
 */
export async function recoverStaleSendingDeliveries(
  options: RecoverStaleOptions,
): Promise<readonly string[]> {
  return workerDataSource() === "db"
    ? recoverStaleSendingDeliveriesDb(options.staleAfterSeconds)
    : recoverStaleSendingDeliveriesMock(options.staleAfterSeconds);
}

/**
 * Operator-facing loop wrapper. Wires `processNextQueuedEmail` and
 * `recoverStaleSendingDeliveries` into the pure-logic runtime so a
 * single call can drain (a bounded prefix of) the queue.
 *
 * The `runtime.server.ts` module accepts injected `tick` and `recover`
 * callbacks for testability — they're bound here.
 */
/**
 * Production preflight: pure env check. Mock data source skips Gmail
 * env entirely because the mock tick / recover paths never call Gmail.
 * Anything unexpected from `assertGmailTransportConfig()` bubbles up
 * and the runtime catches it as `fatal_error`.
 */
function preflightDeps(): readonly string[] {
  if (workerDataSource() !== "db") return [];
  try {
    assertGmailTransportConfig();
    return [];
  } catch (error) {
    if (error instanceof WorkerMisconfiguredError) return error.missing;
    throw error;
  }
}

export async function runWorkerLoop(
  options: DeliveryWorkerLoopOptions,
): Promise<DeliveryWorkerLoopSummary> {
  return runDeliveryWorkerLoop(options, {
    preflight: preflightDeps,
    tick: processNextQueuedEmail,
    recover: (staleAfterSeconds) =>
      recoverStaleSendingDeliveries({ staleAfterSeconds }),
  });
}
