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

import type { Delivery, ID, QueuedDelivery } from "../domain";
import type {
  DeliveriesListOptions,
  DeliveryQueueItem,
  DeliveryEnqueueInput,
  DeliveryStatus,
  OwnerId,
  Tx,
} from "./types";

export interface MarkStatusInput {
  readonly deliveryId: ID;
  readonly status: DeliveryStatus;
  readonly providerMessageId?: string;
  readonly providerStatus?: string;
  readonly deliveredAtISO?: string;
  readonly openedAtISO?: string;
  readonly failureReason?: string;
}

export interface MarkStatusResult {
  /** True iff the row's `status` changed as a result of this call. */
  readonly updated: boolean;
  /** The row's status after the call (idempotent / final). */
  readonly status: DeliveryStatus;
}

export interface DeliveryRepository {
  // ── User-scoped ────────────────────────────────────────────────────────

  listByMonth(
    ownerId: OwnerId,
    options: DeliveriesListOptions,
    tx?: Tx,
  ): Promise<Delivery[]>;

  /**
   * Persist a queued delivery row. Returns the queued receipt rather than a
   * `Delivery` because `Delivery` requires a non-null `sentAtISO` (History
   * shape); a row that has not been sent yet has `sent_at` NULL in the DB.
   */
  enqueue(
    ownerId: OwnerId,
    input: DeliveryEnqueueInput,
    tx?: Tx,
  ): Promise<QueuedDelivery>;

  // ── Worker / webhook (no ownerId) ──────────────────────────────────────

  /**
   * Idempotent + monotonic status update.
   *
   *   - `status` is the target. Implementations advance the row only when
   *     the target ranks strictly above the current status in the
   *     forward order `queued < sending < sent < delivered < opened`.
   *     `'failed'` is a side-branch terminal: writable from
   *     {queued, sending, sent} but NOT from {delivered, opened, failed}.
   *   - Idempotent same-status calls leave the row unchanged but still
   *     return the row's final status, so webhook providers can retry.
   *   - Timestamps (`sent_at`, `delivered_at`, `opened_at`) are stamped
   *     only on the first transition through their state and are never
   *     overwritten.
   *   - `provider_message_id`, `provider_status`, `failure_reason` are
   *     COALESCEd in.
   *
   * `updated === false` means the row didn't move (already at or past
   * the target, or already terminal). The webhook ingest treats that
   * the same as success.
   */
  markStatus(input: MarkStatusInput, tx?: Tx): Promise<MarkStatusResult>;

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

  /**
   * Recover deliveries that have been stuck in `'sending'` for longer than
   * `staleAfterSeconds`. Implementations move them back to `'queued'` so a
   * subsequent worker tick re-attempts the send.
   *
   * IMPORTANT: this CAN introduce a duplicate send when Gmail accepted
   * the original send but the worker died before the finalise tx
   * committed. There is no Gmail-side dedup, so operators must understand
   * the risk before lowering the threshold.
   *
   * Worker-only call site; the request path must not use this.
   */
  requeueStaleSending(
    staleAfterSeconds: number,
    tx?: Tx,
  ): Promise<readonly ID[]>;
}
