import "server-only";

import { createDeliveryRepository } from "@/lib/repositories/deliveries.server";
import { workerTransaction } from "@/lib/server/db/transaction.server";
import type { DeliveryStatus } from "@/lib/repositories/types";
import type { WebhookIngestInput, WebhookIngestResult } from "./types";

// DB ingest. Runs under `workerTransaction` — the connection role is
// BYPASSRLS so the row lookup by provider_message_id can succeed
// regardless of the owner. The repository call is the only DB touch;
// no current-user resolution, no other side effects.

const deliveryRepository = createDeliveryRepository();

export async function ingestWebhookEventDb(
  input: WebhookIngestInput,
): Promise<WebhookIngestResult> {
  return workerTransaction(async (tx) => {
    const row = await deliveryRepository.findByProviderMessageId(
      input.providerMessageId,
      tx,
    );
    if (!row) {
      return {
        ok: false,
        status: 404,
        code: "delivery_not_found",
      } as const;
    }

    const targetStatus: DeliveryStatus =
      input.event === "delivered"
        ? "delivered"
        : input.event === "opened"
          ? "opened"
          : "failed";

    // For 'opened', stamp delivered_at too — opened implies delivered
    // even when the provider skips the delivered event. The repo
    // already enforces no-downgrade and COALESCEs the timestamps so a
    // late event can't overwrite the original delivered_at.
    const occurredAt = input.occurredAtISO;
    const deliveredAtISO =
      input.event === "delivered" || input.event === "opened"
        ? occurredAt
        : undefined;
    const openedAtISO = input.event === "opened" ? occurredAt : undefined;
    const failureReason =
      input.event === "failed" ? (input.failureReason ?? "unspecified") : undefined;

    const result = await deliveryRepository.markStatus(
      {
        deliveryId: row.id,
        status: targetStatus,
        providerStatus: input.providerStatus,
        deliveredAtISO,
        openedAtISO,
        failureReason,
      },
      tx,
    );

    return {
      ok: true,
      status: 200,
      deliveryId: row.id,
      deliveryStatus: result.status,
      updated: result.updated,
    } as const;
  });
}
