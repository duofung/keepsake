import "server-only";

// DB delivery-worker. One queued email per call.
//
// The worker is split into three transactions on purpose:
//
//   1. CLAIM   (workerTransaction): SELECT FOR UPDATE SKIP LOCKED limits
//      visibility to a single concurrent worker; then markStatus(id,
//      'sending') flips the row so other workers (and re-entries of this
//      one) skip it. The lock is released at COMMIT but the status guard
//      keeps the row exclusive.
//
//   2. HYDRATE (workerTransaction, read-only): load the draft body +
//      sender credentials. Separate tx so we don't hold any locks across
//      the Gmail HTTP call.
//
//   3. FINALISE (workerTransaction): markStatus(id, 'sent' | 'failed',
//      providerMessageId?). Idempotent — calling twice with the same
//      arguments is a no-op.
//
// Failure between (2) and (3) leaves the row in 'sending'. There is no
// reaper in this slice — operators handle stuck-sending manually. The
// brief explicitly defers retry / dead-letter queues.

import type { DeliveryQueueItem, OwnerId, Tx } from "@/lib/repositories";
import type { ID } from "@/lib/domain";
import { createDeliveryRepository } from "@/lib/repositories/deliveries.server";
import { createDraftRepository } from "@/lib/repositories/drafts.server";
import { createGmailAccountRepository } from "@/lib/repositories/gmail-accounts.server";
import { workerTransaction } from "@/lib/server/db/transaction.server";
import {
  GmailTransportError,
  WorkerMisconfiguredError,
  assertGmailTransportConfig,
  sendGmailPlainText,
  type GmailSendResult,
} from "./gmail-transport.server";
import type { WorkerFailureReason, WorkerResult } from "./types";

const deliveryRepository = createDeliveryRepository();
const draftRepository = createDraftRepository();
const gmailAccountRepository = createGmailAccountRepository();

interface HydrationFailure {
  ok: false;
  reason: WorkerFailureReason;
  detail?: string;
}

interface HydrationSuccess {
  ok: true;
  subject: string;
  paragraphs: { text: string }[];
  refreshToken: string;
  fromEmail: string;
  ownerId: OwnerId;
  senderStatus: "connected" | "expired";
  accountId: string;
}

async function hydrate(
  item: DeliveryQueueItem,
  tx: Tx,
): Promise<HydrationSuccess | HydrationFailure> {
  if (!item.recipientEmail) {
    return { ok: false, reason: "missing_recipient" };
  }
  if (!item.draftId) {
    return { ok: false, reason: "missing_draft", detail: "queued row has draftId=null" };
  }

  const draftEntry = await draftRepository.getEditBaseById(item.ownerId, item.draftId, tx);
  if (!draftEntry) {
    return { ok: false, reason: "missing_draft" };
  }

  const creds = await gmailAccountRepository.getSendingCredentials(item.ownerId, tx);
  if (!creds) {
    return { ok: false, reason: "missing_credentials" };
  }
  if (creds.status !== "connected") {
    return {
      ok: false,
      reason: "sender_expired",
      detail: `Gmail account ${creds.email} is in status ${creds.status}.`,
    };
  }

  return {
    ok: true,
    subject: draftEntry.draft.subject,
    paragraphs: draftEntry.draft.paragraphs.map((p) => ({ text: p.text })),
    refreshToken: creds.refreshToken,
    fromEmail: creds.email,
    accountId: creds.accountId,
    senderStatus: creds.status,
    ownerId: item.ownerId,
  };
}

export async function processNextQueuedEmailDb(): Promise<WorkerResult> {
  // 0. ASSERT GLOBAL CONFIG.
  // Done BEFORE the claim transaction so a deployment-level misconfig
  // (missing GOOGLE_CLIENT_ID/SECRET) cannot burn a queued user delivery
  // to status='failed'. The queue stays intact and the operator gets a
  // clean misconfigured result they can act on.
  try {
    assertGmailTransportConfig();
  } catch (error) {
    if (error instanceof WorkerMisconfiguredError) {
      return { status: "misconfigured", missing: error.missing };
    }
    throw error;
  }

  // 1. CLAIM
  const claimed = await workerTransaction(async (tx) => {
    const items = await deliveryRepository.nextQueued(1, tx);
    if (items.length === 0) return null;
    const item = items[0];
    await deliveryRepository.markStatus(item.id, "sending", undefined, tx);
    return item;
  });
  if (!claimed) return { status: "nothing_to_do" };

  // 2. HYDRATE
  const hydration = await workerTransaction(async (tx) => hydrate(claimed, tx));

  if (!hydration.ok) {
    await workerTransaction(async (tx) => {
      await deliveryRepository.markStatus(claimed.id, "failed", undefined, tx);
    });
    return {
      status: "failed",
      deliveryId: claimed.id,
      reason: hydration.reason,
      detail: hydration.detail,
    };
  }

  // 3. CALL GMAIL (no DB lock held)
  let sendResult: GmailSendResult | null = null;
  let transportError: GmailTransportError | null = null;

  try {
    sendResult = await sendGmailPlainText({
      refreshToken: hydration.refreshToken,
      email: {
        fromEmail: hydration.fromEmail,
        toEmail: claimed.recipientEmail!,
        subject: hydration.subject,
        paragraphs: hydration.paragraphs,
        messageIdSeed: claimed.id,
      },
    });
  } catch (error) {
    transportError =
      error instanceof GmailTransportError
        ? error
        : new GmailTransportError(
            "transport_error",
            (error as Error)?.message ?? "unknown",
          );
  }

  // 4. FINALISE
  if (transportError) {
    await workerTransaction(async (tx) => {
      await deliveryRepository.markStatus(claimed.id, "failed", undefined, tx);
      // Token-invalid means the refresh token is dead — surface that on
      // the Gmail account so a future enqueue can hit the 409 path
      // instead of queuing yet another row that can't be sent.
      if (transportError!.reason === "token_invalid") {
        try {
          await gmailAccountRepository.markExpired(
            hydration.ownerId,
            hydration.accountId,
            { lastError: transportError!.message },
            tx,
          );
        } catch {
          // Best-effort. If markExpired itself fails, the delivery is
          // still recorded as failed and an operator can investigate.
        }
      }
    });
    return {
      status: "failed",
      deliveryId: claimed.id,
      reason: transportError.reason,
      detail: transportError.message,
    };
  }

  // strict providerMessageId: send path guarantees non-empty string when
  // transportError is null (see `sendGmailPlainText`'s 2xx-no-id guard).
  const providerMessageId = sendResult!.providerMessageId;
  await workerTransaction(async (tx) => {
    await deliveryRepository.markStatus(
      claimed.id,
      "sent",
      providerMessageId,
      tx,
    );
  });
  return { status: "sent", deliveryId: claimed.id, providerMessageId };
}

/**
 * Move stuck `'sending'` rows back to `'queued'` so a subsequent worker
 * tick re-attempts them. Only rows whose last `updated_at` is older than
 * `staleAfterSeconds` are touched, so we don't fight a healthy worker
 * mid-send.
 *
 * DUPLICATE-SEND RISK: if Gmail accepted the original send and the worker
 * died after Gmail's 2xx but before the finalise tx committed, requeue
 * will cause a SECOND send to the same recipient. There is no Gmail
 * idempotency we can rely on here. The runtime contract surfaces the
 * recovered-id count to operators so they can audit; the threshold
 * default in `runtime.server.ts` is intentionally conservative.
 */
export async function recoverStaleSendingDeliveriesDb(
  staleAfterSeconds: number,
): Promise<readonly ID[]> {
  return workerTransaction(async (tx) => {
    return deliveryRepository.requeueStaleSending(staleAfterSeconds, tx);
  });
}
