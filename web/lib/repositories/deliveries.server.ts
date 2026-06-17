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

type QueueItemRow = QueryResultRow & {
  id: string;
  owner_id: string;
  person_id: string | null;
  draft_id: string | null;
  recipient_name_enc: Uint8Array;
  recipient_email_enc: Uint8Array | null;
  recipient_address_enc: Uint8Array | null;
  occasion_kind: OccasionKind;
  occasion_label_enc: Uint8Array;
  channel: Channel;
  scheduled_for_iso: string | null;
};

async function queueItemFromRow(row: QueueItemRow): Promise<DeliveryQueueItem> {
  const ownerId = row.owner_id as OwnerId;
  const [recipientName, recipientEmail, recipientAddress, occasionLabel] = await Promise.all([
    decryptText(ownerId, "recipient_name_enc", row.recipient_name_enc),
    row.recipient_email_enc
      ? decryptText(ownerId, "recipient_email_enc", row.recipient_email_enc)
      : Promise.resolve(undefined),
    row.recipient_address_enc
      ? decryptText(ownerId, "recipient_address_enc", row.recipient_address_enc)
      : Promise.resolve(undefined),
    decryptText(ownerId, "occasion_label_enc", row.occasion_label_enc),
  ]);

  return {
    id: row.id,
    ownerId,
    personId: row.person_id,
    draftId: row.draft_id,
    recipientName,
    recipientEmail,
    recipientAddress,
    occasionKind: row.occasion_kind,
    occasionLabel,
    channel: row.channel,
    scheduledForISO: row.scheduled_for_iso ?? undefined,
    status: "queued",
  };
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
    deliveryId: ID,
    status: DeliveryStatus,
    providerMessageId?: string,
    tx?: Tx,
  ): Promise<void> {
    // Idempotent + monotonic: setting status='sent' twice with the same
    // provider id is a no-op; provider_message_id, once written, sticks
    // (COALESCE keeps the first non-null value). sent_at is stamped the
    // first time status flips to 'sent'.
    //
    // No ownerId is taken because the call sites are worker / webhook —
    // see the interface contract in deliveries.ts.
    if (!tx) {
      throw new Error(
        "DeliveryRepository.markStatus must be called inside a worker / webhook tx.",
      );
    }
    await query(
      tx,
      `
        UPDATE deliveries
        SET status = $2::delivery_status,
            sent_at = CASE
              WHEN $2 = 'sent' AND sent_at IS NULL THEN now()
              ELSE sent_at
            END,
            provider_message_id = COALESCE($3, provider_message_id),
            updated_at = now()
        WHERE id = $1::uuid
      `,
      [deliveryId, status, providerMessageId ?? null],
    );
  }

  async findByProviderMessageId(
    providerMessageId: string,
    tx?: Tx,
  ): Promise<Delivery | null> {
    if (!tx) {
      throw new Error(
        "DeliveryRepository.findByProviderMessageId must be called inside a worker / webhook tx.",
      );
    }
    const result = await query<DeliveryRow & QueryResultRow & { owner_id: string }>(
      tx,
      `
        SELECT
          id::text AS id,
          owner_id::text AS owner_id,
          person_id::text AS person_id,
          recipient_name_enc,
          occasion_kind,
          occasion_label_enc,
          channel,
          to_char(sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS sent_at_iso,
          status
        FROM deliveries
        WHERE provider_message_id = $1
        LIMIT 1
      `,
      [providerMessageId],
    );
    const row = result.rows[0];
    if (!row) return null;
    // sent_at IS NULL means the worker stored provider_message_id but
    // crashed before flipping status='sent'. We can't return a Delivery
    // shape without sentAtISO; return null and let the caller treat it
    // as "no webhook target".
    if (!row.sent_at_iso) return null;
    return deliveryFromRow(row.owner_id as OwnerId, row);
  }

  async nextQueued(limit: number, tx?: Tx): Promise<DeliveryQueueItem[]> {
    // FOR UPDATE SKIP LOCKED is the no-double-send primitive. Two workers
    // running concurrently will each lock disjoint rows; this method itself
    // does not mutate status. Call sites must, in the SAME transaction,
    // call `markStatus(id, 'sending', ...)` before committing — otherwise
    // releasing the row lock leaves another worker free to re-pick it.
    if (!tx) {
      throw new Error(
        "DeliveryRepository.nextQueued must be called inside a worker tx so the row lock survives commit ordering.",
      );
    }
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const result = await query<QueueItemRow>(
      tx,
      `
        SELECT
          id::text AS id,
          owner_id::text AS owner_id,
          person_id::text AS person_id,
          draft_id::text AS draft_id,
          recipient_name_enc,
          recipient_email_enc,
          recipient_address_enc,
          occasion_kind,
          occasion_label_enc,
          channel,
          to_char(scheduled_for AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS scheduled_for_iso
        FROM deliveries
        WHERE status = 'queued'
          AND channel = 'email'
          AND (scheduled_for IS NULL OR scheduled_for <= now())
        ORDER BY scheduled_for ASC NULLS FIRST,
                 created_at ASC,
                 id ASC
        LIMIT $1::int
        FOR UPDATE SKIP LOCKED
      `,
      [safeLimit],
    );

    return Promise.all(result.rows.map(queueItemFromRow));
  }
}

export function createDeliveryRepository(): DeliveryRepository {
  return new PgDeliveryRepository();
}
