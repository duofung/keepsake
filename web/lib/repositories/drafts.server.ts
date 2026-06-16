import "server-only";

import type { QueryResultRow } from "pg";
import type {
  AttachedCard,
  DraftParagraph,
  DraftQuickAction,
  MessageDraft,
  Tone,
} from "../domain";
import { decrypt, encrypt } from "@/lib/server/crypto/envelope.server";
import { query, transaction } from "@/lib/server/db/transaction.server";
import type { DraftRepository } from "./drafts";
import type { MessageDraftSaveInput, OwnerId, Tx } from "./types";

type DraftRow = QueryResultRow & {
  id: string;
  person_id: string;
  occasion_id: string | null;
  tone: Tone;
  tone_label: string;
  alternative_tones: unknown;
  subject_enc: Uint8Array;
  paragraphs_enc: Uint8Array;
  attached_card: unknown | null;
  quick_actions: unknown;
  assistant_note_enc: Uint8Array;
};

type DraftRowWithProvenance = DraftRow & {
  user_instruction_enc: Uint8Array;
  model_provider: string | null;
  model_version: string | null;
};

const TABLE = "message_drafts";
const TONES = new Set<Tone>([
  "tender-intimate",
  "playful",
  "heartfelt",
  "warm-caring",
  "warm-festive",
  "warm-easy",
  "light-warm",
]);

const DRAFT_SELECT = `
  SELECT
    id::text,
    person_id::text,
    occasion_id::text,
    tone,
    tone_label,
    alternative_tones,
    subject_enc,
    paragraphs_enc,
    attached_card,
    quick_actions,
    assistant_note_enc
  FROM message_drafts
`;

async function withTx<T>(
  ownerId: OwnerId,
  tx: Tx | undefined,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return tx ? fn(tx) : transaction(ownerId, fn);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTone(value: unknown): value is Tone {
  return typeof value === "string" && TONES.has(value as Tone);
}

function mapAlternativeTones(value: unknown): { tone: Tone; label: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || !isTone(item.tone) || typeof item.label !== "string") {
      return [];
    }
    return [{ tone: item.tone, label: item.label }];
  });
}

function mapParagraphs(value: unknown): DraftParagraph[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.text !== "string") return [];

    const paragraph: DraftParagraph = { text: item.text };
    if (Array.isArray(item.highlights)) {
      const highlights = item.highlights.filter((highlight): highlight is string => (
        typeof highlight === "string"
      ));
      if (highlights.length) paragraph.highlights = highlights;
    }

    return [paragraph];
  });
}

function mapAttachedCard(value: unknown): AttachedCard | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.styleLabel !== "string"
    || typeof value.description !== "string"
    || typeof value.paletteHint !== "string"
    || typeof value.iconHint !== "string"
  ) {
    return null;
  }

  return {
    styleLabel: value.styleLabel,
    description: value.description,
    paletteHint: value.paletteHint,
    iconHint: value.iconHint,
  };
}

function mapQuickActions(value: unknown): DraftQuickAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      !isRecord(item)
      || typeof item.label !== "string"
      || typeof item.prompt !== "string"
      || typeof item.iconHint !== "string"
    ) {
      return [];
    }

    return [{
      label: item.label,
      prompt: item.prompt,
      iconHint: item.iconHint,
    }];
  });
}

async function encryptText(
  ownerId: OwnerId,
  column: string,
  value: string,
): Promise<Buffer> {
  const bytes = await encrypt(ownerId, TABLE, column, Buffer.from(value, "utf8"));
  return Buffer.from(bytes);
}

async function encryptJson(
  ownerId: OwnerId,
  column: string,
  value: unknown,
): Promise<Buffer> {
  return encryptText(ownerId, column, JSON.stringify(value));
}

async function decryptText(
  ownerId: OwnerId,
  column: string,
  value: Uint8Array,
): Promise<string> {
  return Buffer.from(await decrypt(ownerId, TABLE, column, value)).toString("utf8");
}

async function decryptJson(
  ownerId: OwnerId,
  column: string,
  value: Uint8Array,
): Promise<unknown> {
  return JSON.parse(await decryptText(ownerId, column, value));
}

async function draftFromRow(ownerId: OwnerId, row: DraftRow): Promise<MessageDraft> {
  return {
    id: row.id,
    personId: row.person_id,
    occasionId: row.occasion_id,
    tone: row.tone,
    toneLabel: row.tone_label,
    alternativeTones: mapAlternativeTones(row.alternative_tones),
    subject: await decryptText(ownerId, "subject_enc", row.subject_enc),
    paragraphs: mapParagraphs(await decryptJson(ownerId, "paragraphs_enc", row.paragraphs_enc)),
    attachedCard: mapAttachedCard(row.attached_card),
    quickActions: mapQuickActions(row.quick_actions),
    assistantNote: await decryptText(ownerId, "assistant_note_enc", row.assistant_note_enc),
  };
}

export class PgDraftRepository implements DraftRepository {
  async getEditBaseById(
    ownerId: OwnerId,
    draftId: string,
    tx?: Tx,
  ): Promise<{
    readonly draft: MessageDraft;
    readonly userInstruction: string;
    readonly modelProvider: string | null;
    readonly modelVersion: string | null;
  } | null> {
    return withTx(ownerId, tx, async (activeTx) => {
      const result = await query<DraftRowWithProvenance>(
        activeTx,
        `
          SELECT
            id::text,
            person_id::text,
            occasion_id::text,
            tone,
            tone_label,
            alternative_tones,
            subject_enc,
            paragraphs_enc,
            attached_card,
            quick_actions,
            assistant_note_enc,
            user_instruction_enc,
            model_provider,
            model_version
          FROM message_drafts
          WHERE owner_id = $1
            AND id = $2
          LIMIT 1
        `,
        [ownerId, draftId],
      );

      const row = result.rows[0];
      if (!row) return null;

      const [draft, userInstruction] = await Promise.all([
        draftFromRow(ownerId, row),
        decryptText(ownerId, "user_instruction_enc", row.user_instruction_enc),
      ]);

      return {
        draft,
        userInstruction,
        modelProvider: row.model_provider,
        modelVersion: row.model_version,
      };
    });
  }

  async findByPromptHash(
    ownerId: OwnerId,
    promptHash: string,
    tx?: Tx,
  ): Promise<MessageDraft | null> {
    return withTx(ownerId, tx, async (activeTx) => {
      const result = await query<DraftRow>(
        activeTx,
        `
          ${DRAFT_SELECT}
          WHERE owner_id = $1
            AND prompt_input_hash = $2
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `,
        [ownerId, promptHash],
      );

      return result.rows[0] ? draftFromRow(ownerId, result.rows[0]) : null;
    });
  }

  async getLatestFor(
    ownerId: OwnerId,
    personId: string,
    occasionId: string | null,
    tx?: Tx,
  ): Promise<MessageDraft | null> {
    return withTx(ownerId, tx, async (activeTx) => {
      const values: unknown[] = [ownerId, personId];
      const occasionClause = occasionId === null
        ? "occasion_id IS NULL"
        : `occasion_id = $${values.push(occasionId)}`;

      const result = await query<DraftRow>(
        activeTx,
        `
          ${DRAFT_SELECT}
          WHERE owner_id = $1
            AND person_id = $2
            AND ${occasionClause}
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `,
        values,
      );

      return result.rows[0] ? draftFromRow(ownerId, result.rows[0]) : null;
    });
  }

  async save(
    ownerId: OwnerId,
    input: MessageDraftSaveInput,
    tx?: Tx,
  ): Promise<MessageDraft> {
    return withTx(ownerId, tx, async (activeTx) => {
      const result = await query<DraftRow>(
        activeTx,
        `
          INSERT INTO message_drafts (
            owner_id,
            person_id,
            occasion_id,
            tone,
            tone_label,
            alternative_tones,
            subject_enc,
            paragraphs_enc,
            attached_card,
            quick_actions,
            assistant_note_enc,
            model_provider,
            model_version,
            prompt_input_hash,
            user_instruction_enc
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6::jsonb,
            $7,
            $8,
            $9::jsonb,
            $10::jsonb,
            $11,
            $12,
            $13,
            $14,
            $15
          )
          RETURNING
            id::text,
            person_id::text,
            occasion_id::text,
            tone,
            tone_label,
            alternative_tones,
            subject_enc,
            paragraphs_enc,
            attached_card,
            quick_actions,
            assistant_note_enc
        `,
        [
          ownerId,
          input.personId,
          input.occasionId,
          input.tone,
          input.toneLabel,
          JSON.stringify(input.alternativeTones),
          await encryptText(ownerId, "subject_enc", input.subject),
          await encryptJson(ownerId, "paragraphs_enc", input.paragraphs),
          input.attachedCard === null ? null : JSON.stringify(input.attachedCard),
          JSON.stringify(input.quickActions),
          await encryptText(ownerId, "assistant_note_enc", input.assistantNote),
          input.modelProvider ?? null,
          input.modelVersion ?? null,
          input.promptHash,
          await encryptText(ownerId, "user_instruction_enc", input.userInstruction),
        ],
      );

      return draftFromRow(ownerId, result.rows[0]);
    });
  }

  async listForPerson(
    ownerId: OwnerId,
    personId: string,
    limit: number,
    tx?: Tx,
  ): Promise<MessageDraft[]> {
    return withTx(ownerId, tx, async (activeTx) => {
      const safeLimit = Math.max(0, Math.trunc(limit));
      const result = await query<DraftRow>(
        activeTx,
        `
          ${DRAFT_SELECT}
          WHERE owner_id = $1
            AND person_id = $2
          ORDER BY created_at DESC, id DESC
          LIMIT $3::int
        `,
        [ownerId, personId, safeLimit],
      );

      return Promise.all(result.rows.map((row) => draftFromRow(ownerId, row)));
    });
  }
}

export function createDraftRepository(): DraftRepository {
  return new PgDraftRepository();
}
