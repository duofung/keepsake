import "server-only";

import type { QueryResultRow } from "pg";
import type { Delivery, ID } from "../domain";
import { decrypt } from "@/lib/server/crypto/envelope.server";
import { query, transaction } from "@/lib/server/db/transaction.server";
import type { DeliveryRepository } from "./deliveries";
import type {
  DeliveriesListOptions,
  DeliveryEnqueueInput,
  DeliveryQueueItem,
  DeliveryStatus,
  OwnerId,
  Tx,
} from "./types";

type DeliveryRow = QueryResultRow & {
  id: string;
  person_id: string | null;
  recipient_name_enc: Uint8Array;
  occasion_kind: Delivery["occasionKind"];
  occasion_label_enc: Uint8Array;
  channel: Delivery["channel"];
  sent_at_iso: string;
  status: DeliveryStatus;
};

async function withTx<T>(
  ownerId: OwnerId,
  tx: Tx | undefined,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return tx ? fn(tx) : transaction(ownerId, fn);
}

async function decryptText(
  ownerId: OwnerId,
  column: string,
  value: Uint8Array,
): Promise<string> {
  return Buffer.from(await decrypt(ownerId, "deliveries", column, value)).toString("utf8");
}

async function deliveryFromRow(ownerId: OwnerId, row: DeliveryRow): Promise<Delivery> {
  return {
    id: row.id,
    personId: row.person_id ?? null,
    recipientName: await decryptText(ownerId, "recipient_name_enc", row.recipient_name_enc),
    occasionKind: row.occasion_kind,
    occasionLabel: await decryptText(ownerId, "occasion_label_enc", row.occasion_label_enc),
    channel: row.channel,
    sentAtISO: row.sent_at_iso,
    status: row.status,
  };
}

function notImplemented(method: string): never {
  throw new Error(`DeliveryRepository.${method} is not implemented yet.`);
}

export class PgDeliveryRepository implements DeliveryRepository {
  async listByMonth(
    ownerId: OwnerId,
    options: DeliveriesListOptions,
    tx?: Tx,
  ): Promise<Delivery[]> {
    return withTx(ownerId, tx, async (activeTx) => {
      const values: unknown[] = [ownerId];
      const where = [
        "owner_id = $1",
        "sent_at IS NOT NULL",
      ];

      if (options.beforeISO) {
        values.push(options.beforeISO);
        where.push(`sent_at < $${values.length}::timestamptz`);
      }

      values.push(options.limit ?? 50);
      const limitPlaceholder = `$${values.length}::int`;

      const result = await query<DeliveryRow>(
        activeTx,
        `
          SELECT
            id::text AS id,
            person_id::text AS person_id,
            recipient_name_enc,
            occasion_kind,
            occasion_label_enc,
            channel,
            to_char(sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS sent_at_iso,
            status
          FROM deliveries
          WHERE ${where.join(" AND ")}
          ORDER BY sent_at DESC, id DESC
          LIMIT ${limitPlaceholder}
        `,
        values,
      );

      return Promise.all(result.rows.map((row) => deliveryFromRow(ownerId, row)));
    });
  }

  async enqueue(
    _ownerId: OwnerId,
    _input: DeliveryEnqueueInput,
    _tx?: Tx,
  ): Promise<Delivery> {
    return notImplemented("enqueue");
  }

  async markStatus(
    _deliveryId: ID,
    _status: DeliveryStatus,
    _providerMessageId?: string,
    _tx?: Tx,
  ): Promise<void> {
    return notImplemented("markStatus");
  }

  async findByProviderMessageId(
    _providerMessageId: string,
    _tx?: Tx,
  ): Promise<Delivery | null> {
    return notImplemented("findByProviderMessageId");
  }

  async nextQueued(_limit: number, _tx?: Tx): Promise<DeliveryQueueItem[]> {
    return notImplemented("nextQueued");
  }
}

export function createDeliveryRepository(): DeliveryRepository {
  return new PgDeliveryRepository();
}
