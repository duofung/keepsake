import "server-only";

import type { WebhookIngestInput, WebhookIngestResult } from "./types";

// Mock mode has no `deliveries` rows, so every webhook event resolves
// to `delivery_not_found`. The webhook contract is fully exercisable
// against this path — secret gate at the route + shape validation in
// the seam — without needing Postgres for the default smoke chain.

export async function ingestWebhookEventMock(
  _input: WebhookIngestInput,
): Promise<WebhookIngestResult> {
  return { ok: false, status: 404, code: "delivery_not_found" };
}
