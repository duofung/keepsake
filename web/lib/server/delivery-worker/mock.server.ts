import "server-only";

// Mock delivery-worker dispatcher path.
//
// Mock mode has no DB-backed queue, so there is nothing to send. The mock
// implementation deliberately returns `nothing_to_do` so that:
//
//   * the manual run script (`scripts/run-delivery-worker.mjs`) works
//     against any environment without crashing,
//   * any consumer wired up against the public `processNextQueuedEmail()`
//     surface gets a stable result without DB / Gmail dependencies,
//   * default-mode dev/local UI work doesn't accidentally fire HTTP calls
//     out the back.
//
// The real send mechanics live in `db.server.ts` + `gmail-transport.server.ts`.

import type { WorkerResult } from "./types";

export async function processNextQueuedEmailMock(): Promise<WorkerResult> {
  return { status: "nothing_to_do" };
}
