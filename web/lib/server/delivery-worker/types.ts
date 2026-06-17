// Delivery-worker contract. Imported by the dispatcher, both data sources,
// and the manual run script. Type-only — no runtime imports — so it stays
// safe for cross-boundary use.

import type { ID } from "@/lib/domain";

/**
 * Why a single delivery cannot be sent. Surfaces in `WorkerResult` so the
 * manual run script + tests can reason about failure modes without the
 * worker leaking provider URLs / stack traces.
 */
export type WorkerFailureReason =
  | "missing_recipient"      // queued row had no recipient_email_enc
  | "missing_draft"          // draft_id null or draft no longer exists
  | "missing_credentials"    // no primary Gmail account for the owner
  | "sender_expired"         // Gmail credentials exist but `status !== connected`
  | "token_invalid"          // refresh-token exchange returned invalid_grant
  | "gmail_send_error"       // Gmail send endpoint returned non-2xx
  | "transport_error";       // network failure / unexpected runtime error

/**
 * The outcome of a single worker tick (`processNextQueuedEmail()`).
 *
 *   nothing_to_do  → no queued email rows; safe to schedule the next poll
 *   sent           → row moved queued → sending → sent; provider id captured
 *   failed         → terminal failure; row moved queued → sending → failed
 *   misconfigured  → worker's global Gmail env is missing; NO row was
 *                    claimed, NO DB write happened. Operators must fix the
 *                    deployment before the worker can drain the queue.
 *
 * There is no `retried` / `requeued` variant in this slice — we have no
 * retry queue. Operators / future cron decide what to do with `failed` rows.
 */
export type WorkerResult =
  | { status: "nothing_to_do" }
  | {
      status: "sent";
      deliveryId: ID;
      /** Gmail's canonical message id. Always non-empty on `sent`. */
      providerMessageId: string;
    }
  | {
      status: "failed";
      deliveryId: ID;
      reason: WorkerFailureReason;
      detail?: string;
    }
  | {
      status: "misconfigured";
      /** Env var names that were missing or empty. */
      missing: readonly string[];
    };
