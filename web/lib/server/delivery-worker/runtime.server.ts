import "server-only";

// Delivery-worker loop runtime.
//
// Pure logic, no static runtime imports. The caller (the index seam, or
// a test) injects:
//   - `tick`: how to run one worker tick (typically `processNextQueuedEmail`)
//   - `recover`: how to requeue stale `'sending'` rows (typically
//     `recoverStaleSendingDeliveries` from the index seam)
//
// Loop semantics:
//   1. Call `preflight()`. Any missing items short-circuit the loop
//      with `stopReason: "misconfigured"`. **No DB writes, no Gmail
//      HTTP, and crucially no recovery.** A deployment-level
//      misconfiguration must be side-effect free — we cannot let
//      recovery requeue rows when we already know the send path is
//      broken.
//   2. If `options.recovery` is set, run `recover(staleAfterSeconds)` ONCE.
//   3. Run `tick()` repeatedly until one of these happens:
//      - tick returns `nothing_to_do`           → stopReason "empty"
//      - tick returns `misconfigured`           → stopReason "misconfigured"
//      - tick returns `failed` AND `stopOnFailure` is set → stopReason "stopped_on_failure"
//      - tick throws                            → stopReason "fatal_error"
//      - `ticks` reaches `options.maxTicks`     → stopReason "max_ticks"
//
// `sent` and `failed` count rows that actually transitioned, not just
// ticks. `recovered` counts rows the recovery pass moved back to queued.

import type { WorkerResult } from "./types";

export interface DeliveryWorkerLoopOptions {
  /** Hard upper bound on ticks per call. Must be > 0. No infinite loops. */
  readonly maxTicks: number;
  /** When present, runs `recover(staleAfterSeconds)` once before the loop. */
  readonly recovery?: { readonly staleAfterSeconds: number };
  /** Stop the loop on the first `failed` tick. Default false. */
  readonly stopOnFailure?: boolean;
}

export type WorkerLoopStopReason =
  | "empty"
  | "max_ticks"
  | "misconfigured"
  | "stopped_on_failure"
  | "fatal_error";

export interface DeliveryWorkerLoopSummary {
  readonly ticks: number;
  readonly sent: number;
  readonly failed: number;
  readonly recovered: number;
  readonly stopReason: WorkerLoopStopReason;
  /** Populated only when `stopReason === "misconfigured"`. */
  readonly missing?: readonly string[];
  /** Populated only when `stopReason === "fatal_error"`. */
  readonly fatalError?: string;
}

export interface DeliveryWorkerLoopDeps {
  /**
   * Side-effect-free deployment-level config check. Returns the list of
   * missing env vars (or other static deps). Empty array means "go
   * ahead". Implementations MUST NOT touch the DB or any network. The
   * runtime calls `preflight()` BEFORE recovery so a known-bad
   * deployment cannot trigger a duplicate-send via stale-row requeue.
   */
  preflight(): readonly string[];
  tick(): Promise<WorkerResult>;
  recover(staleAfterSeconds: number): Promise<readonly string[]>;
}

export async function runDeliveryWorkerLoop(
  options: DeliveryWorkerLoopOptions,
  deps: DeliveryWorkerLoopDeps,
): Promise<DeliveryWorkerLoopSummary> {
  if (!(options.maxTicks > 0)) {
    return {
      ticks: 0,
      sent: 0,
      failed: 0,
      recovered: 0,
      stopReason: "max_ticks",
    };
  }

  // Pre-flight FIRST. A deployment-level misconfig must short-circuit
  // before any side-effecting work (recovery would requeue stale rows
  // that carry duplicate-send risk; ticks would either no-op back or
  // claim a row we can't actually send).
  let missingDeps: readonly string[];
  try {
    missingDeps = deps.preflight();
  } catch (error) {
    return {
      ticks: 0,
      sent: 0,
      failed: 0,
      recovered: 0,
      stopReason: "fatal_error",
      fatalError: errorMessage(error, "preflight"),
    };
  }
  if (missingDeps.length > 0) {
    return {
      ticks: 0,
      sent: 0,
      failed: 0,
      recovered: 0,
      stopReason: "misconfigured",
      missing: missingDeps,
    };
  }

  let recovered = 0;
  if (options.recovery) {
    try {
      const ids = await deps.recover(options.recovery.staleAfterSeconds);
      recovered = ids.length;
    } catch (error) {
      return {
        ticks: 0,
        sent: 0,
        failed: 0,
        recovered: 0,
        stopReason: "fatal_error",
        fatalError: errorMessage(error, "recovery"),
      };
    }
  }

  let ticks = 0;
  let sent = 0;
  let failed = 0;

  while (ticks < options.maxTicks) {
    let result: WorkerResult;
    try {
      result = await deps.tick();
    } catch (error) {
      return {
        ticks,
        sent,
        failed,
        recovered,
        stopReason: "fatal_error",
        fatalError: errorMessage(error, "tick"),
      };
    }
    ticks++;

    switch (result.status) {
      case "nothing_to_do":
        return { ticks, sent, failed, recovered, stopReason: "empty" };
      case "misconfigured":
        return {
          ticks,
          sent,
          failed,
          recovered,
          stopReason: "misconfigured",
          missing: result.missing,
        };
      case "sent":
        sent++;
        break;
      case "failed":
        failed++;
        if (options.stopOnFailure) {
          return {
            ticks,
            sent,
            failed,
            recovered,
            stopReason: "stopped_on_failure",
          };
        }
        break;
    }
  }

  return { ticks, sent, failed, recovered, stopReason: "max_ticks" };
}

function errorMessage(error: unknown, phase: "preflight" | "recovery" | "tick"): string {
  const raw = (error as Error)?.message ?? String(error);
  return `${phase}: ${raw}`;
}
