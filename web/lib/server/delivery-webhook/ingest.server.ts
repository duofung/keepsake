import "server-only";

import { dataSource } from "@/lib/server/auth/current-user.server";
import { ingestWebhookEventDb } from "./db.server";
import { ingestWebhookEventMock } from "./mock.server";
import type { WebhookIngestInput, WebhookIngestResult } from "./types";

export type { WebhookIngestInput, WebhookIngestResult } from "./types";

// Provider-agnostic delivery webhook ingest.
//
// Identity = provider message id. The seam never reads `currentUser*`
// because webhook requests are NOT user-authenticated — they arrive
// from the provider/transit layer and are gated by the shared secret
// at the route boundary.
//
// Dispatch by `KEEPSAKE_DATA_SOURCE`: mock mode (the default) has no
// rows to find, so every well-formed event returns
// `delivery_not_found`. The seam still validates the event shape so
// the contract is exercisable without a database.

export async function ingestDeliveryWebhookEvent(
  input: WebhookIngestInput,
): Promise<WebhookIngestResult> {
  const validation = validateEvent(input);
  if (!validation.ok) return validation.error;

  return dataSource() === "db"
    ? ingestWebhookEventDb(validation.value)
    : ingestWebhookEventMock(validation.value);
}

function validateEvent(
  input: WebhookIngestInput,
):
  | { ok: true; value: WebhookIngestInput }
  | { ok: false; error: WebhookIngestResult } {
  if (!input || typeof input !== "object") {
    return {
      ok: false,
      error: { ok: false, status: 400, code: "invalid_event", detail: "body" },
    };
  }
  if (input.provider !== "gmail" && input.provider !== "mock") {
    return {
      ok: false,
      error: { ok: false, status: 400, code: "invalid_event", detail: "provider" },
    };
  }
  if (typeof input.providerMessageId !== "string" || !input.providerMessageId.trim()) {
    return {
      ok: false,
      error: { ok: false, status: 400, code: "invalid_event", detail: "providerMessageId" },
    };
  }
  if (
    input.event !== "delivered" &&
    input.event !== "opened" &&
    input.event !== "failed"
  ) {
    return {
      ok: false,
      error: { ok: false, status: 400, code: "invalid_event", detail: "event" },
    };
  }
  if (input.occurredAtISO !== undefined) {
    if (
      typeof input.occurredAtISO !== "string" ||
      Number.isNaN(Date.parse(input.occurredAtISO))
    ) {
      return {
        ok: false,
        error: {
          ok: false,
          status: 400,
          code: "invalid_event",
          detail: "occurredAtISO",
        },
      };
    }
  }
  return { ok: true, value: input };
}
