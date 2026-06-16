// Result shapes for the delivery-send seam. Type-only.
//
// `POST /api/deliveries` accepts a `DeliveryRequest` from the wire and returns
// either a `QueuedDelivery` receipt (202) or a structured failure. The error
// `code` field is stable enough for clients to branch on; the `error` string
// is for humans/logs.

import type { DeliveryRequest, QueuedDelivery } from "@/lib/domain";

export type { DeliveryRequest };

export type SendBoundaryErrorCode =
  | "invalid_request"
  | "person_not_found"
  | "occasion_not_found"
  | "sender_not_connected"
  | "sender_expired"
  | "no_draft"
  | "service_unavailable";

export type SendBoundaryResult =
  | { ok: true; queued: QueuedDelivery }
  | {
      ok: false;
      status: 400 | 404 | 409 | 500;
      code: SendBoundaryErrorCode;
      error: string;
    };
