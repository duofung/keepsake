import "server-only";

import type { QueryResultRow } from "pg";
import type { Channel, Delivery, ID, OccasionKind, QueuedDelivery } from "../domain";
import { decrypt, encrypt } from "@/lib/server/crypto/envelope.server";
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

const TABLE = "deliveries";

type QueuedRow = QueryResultRow & {
  id: string;
  person_id: string;
  draft_id: string;
  occasion_kind: OccasionKind;
  channel: Channel;
  status: "queued";
  scheduled_for_iso: string | null;
  created_at_iso: string;
};

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
  return Buffer.from(await decrypt(ownerId, TABLE, column, value)).toString("utf8");
}

async function encryptText(
  ownerId: OwnerId,
  column: string,
  value: string,
): Promise<Buffer> {
  const bytes = await encrypt(ownerId, TABLE, column, Buffer.from(value, "utf8"));
  return Buffer.from(bytes);
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
    ownerId: OwnerId,
    input: DeliveryEnqueueInput,
    tx?: Tx,
  ): Promise<QueuedDelivery> {
    return withTx(ownerId, tx, async (activeTx) => {
      const recipientName = await encryptText(
        ownerId,
        "recipient_name_enc",
        input.recipientName,
      );
      const recipientEmail = input.recipientEmail
        ? await encryptText(ownerId, "recipient_email_enc", input.recipientEmail)
        : null;
      const recipientAddress = input.recipientAddress
        ? await encryptText(ownerId, "recipient_address_enc", input.recipientAddress)
        : null;
      const occasionLabel = await encryptText(
        ownerId,
        "occasion_label_enc",
        input.occasionLabel,
      );

      const result = await query<QueuedRow>(
        activeTx,
        `
          INSERT INTO deliveries (
            owner_id,
            person_id,
            draft_id,
            recipient_name_enc,
            recipient_email_enc,
            recipient_address_enc,
            occasion_kind,
            occasion_label_enc,
            channel,
            scheduled_for,
            status
          )
          VALUES (
            $1,
            $2::uuid,
            $3::uuid,
            $4,
            $5,
            $6,
            $7::occasion_kind,
            $8,
            $9::channel,
            $10::timestamptz,
            'queued'
          )
          RETURNING
            id::text AS id,
            person_id::text AS person_id,
            draft_id::text AS draft_id,
            occasion_kind,
            channel,
            status,
            to_char(scheduled_for AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS scheduled_for_iso,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_iso
        `,
        [
          ownerId,
          input.personId,
          input.draftId,
          recipientName,
          recipientEmail,
          recipientAddress,
          input.occasionKind,
          occasionLabel,
          input.channel,
          input.scheduledFor ?? null,
        ],
      );

      const row = result.rows[0];
      if (!row) {
        throw new Error("DeliveryRepository.enqueue returned no row.");
      }

      return {
        id: row.id,
        personId: row.person_id,
        occasionId: input.occasionId,
        draftId: row.draft_id,
        channel: row.channel,
        status: row.status,
        scheduledForISO: row.scheduled_for_iso,
        createdAtISO: row.created_at_iso,
      };
    });
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
