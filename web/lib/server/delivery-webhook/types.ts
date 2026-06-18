// Provider-agnostic delivery webhook contract.
//
// The route layer parses raw JSON into `WebhookIngestInput` and hands it
// to `ingestDeliveryWebhookEvent()`. The seam looks up the row by
// `providerMessageId`, transitions the row's status via
// `DeliveryRepository.markStatus`, and returns a `WebhookIngestResult`.
//
// Identity here is the provider's `providerMessageId` (the value the
// worker stamped into `deliveries.provider_message_id` when it sent the
// message). There is NO user session: the webhook is signed by the
// provider/transit layer, not by a Keepsake user.

import type { DeliveryStatus } from "@/lib/repositories/types";

export type WebhookProvider = "gmail" | "mock";
export type WebhookEvent = "delivered" | "opened" | "failed";

export interface WebhookIngestInput {
  readonly provider: WebhookProvider;
  readonly providerMessageId: string;
  readonly event: WebhookEvent;
  /** Provider-reported event timestamp. Defaults to "now" when omitted. */
  readonly occurredAtISO?: string;
  readonly failureReason?: string;
  /** Optional raw provider-side state string for debugging. */
  readonly providerStatus?: string;
}

export type WebhookIngestResult =
  | {
      readonly ok: true;
      readonly status: 200;
      readonly deliveryId: string;
      readonly deliveryStatus: DeliveryStatus;
      readonly updated: boolean;
    }
  | {
      readonly ok: false;
      readonly status: 400;
      readonly code: "invalid_event";
      readonly detail?: string;
    }
  | {
      readonly ok: false;
      readonly status: 404;
      readonly code: "delivery_not_found";
    }
  | {
      readonly ok: false;
      readonly status: 500;
      readonly code: "ingest_failed";
      readonly detail?: string;
    };
