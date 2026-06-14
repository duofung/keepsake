// DeliveryRepository — `deliveries` reads, the send write path, and the
// webhook callback. Per-user for the request paths; worker-only for the
// drain queue.
//
// Status: DESIGN ONLY. Interface declaration; no implementation.
//
// Caller mapping:
//   listByMonth              → future /api/deliveries GET → History page
//   enqueue                  → future /api/deliveries POST when user clicks Send / Mail
//   markStatus               → future webhook (/api/webhooks/email, postal vendor)
//   findByProviderMessageId  → webhook ingest — no ownerId; the row's own owner_id is the auth proof
//   nextQueued               → send worker — privileged role, bypasses user RLS

import type { Delivery, ID } from "../domain";
import type {
  DeliveriesListOptions,
  DeliveryQueueItem,
  DeliveryEnqueueInput,
  DeliveryStatus,
  OwnerId,
  Tx,
} from "./types";

export interface DeliveryRepository {
  // ── User-scoped ────────────────────────────────────────────────────────

  listByMonth(
    ownerId: OwnerId,
    options: DeliveriesListOptions,
    tx?: Tx,
  ): Promise<Delivery[]>;

  enqueue(
    ownerId: OwnerId,
    input: DeliveryEnqueueInput,
    tx?: Tx,
  ): Promise<Delivery>;

  // ── Worker / webhook (no ownerId) ──────────────────────────────────────

  /**
   * Idempotent status update. Implementations should be safe to call twice
   * with the same `(deliveryId, status)` because webhook providers retry.
   */
  markStatus(
    deliveryId: ID,
    status: DeliveryStatus,
    providerMessageId?: string,
    tx?: Tx,
  ): Promise<void>;

  /**
   * Webhook ingest hands us the provider's message id, not our `owner_id`.
   * RLS does not apply because this is called from a worker role.
   */
  findByProviderMessageId(
    providerMessageId: string,
    tx?: Tx,
  ): Promise<Delivery | null>;

  /**
   * Drain the queue. Implementations should `SELECT … FOR UPDATE SKIP LOCKED`
   * so multiple worker replicas don't double-send. Worker-only call site;
   * the request path must not use this.
   */
  nextQueued(limit: number, tx?: Tx): Promise<DeliveryQueueItem[]>;
}
