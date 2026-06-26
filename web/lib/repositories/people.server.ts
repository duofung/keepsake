import "server-only";

import type { QueryResultRow } from "pg";
import type {
  ContactSegment,
  CultureId,
  OccasionKind,
  OccasionNode,
  PeoplePayload,
  Person,
  PersonKnownFact,
} from "../domain";
import { decrypt, encrypt } from "@/lib/server/crypto/envelope.server";
import { query, transaction } from "@/lib/server/db/transaction.server";
import { createCatalogRepository } from "./catalog.server";
import type { PeopleRepository } from "./people";
import type {
  OccasionUpsertInput,
  OwnerId,
  PersonCreateInput,
  PersonPatch,
  Tx,
} from "./types";

type PeopleRow = QueryResultRow & {
  id: string;
  name_enc: Uint8Array;
  segment: ContactSegment | null;
  organization_enc: Uint8Array | null;
  role_title_enc: Uint8Array | null;
  source_context_enc: Uint8Array | null;
  starred: boolean;
  avatar_bg: string;
  avatar_fg: string;
  relationship_id: string;
  culture_id: CultureId;
  since_enc: Uint8Array | null;
  identity_tags_enc: Uint8Array;
  known_facts_enc: Uint8Array;
  personal_taboos_enc: Uint8Array;
  last_contact_at_iso: string | null;
  next_occasion_id: string | null;
};

type OccasionRow = QueryResultRow & {
  id: string;
  person_id: string;
  kind: OccasionKind;
  label_enc: Uint8Array;
  detail_enc: Uint8Array | null;
  date_iso: string;
  days_until: number;
  is_primary: boolean;
};

const catalog = createCatalogRepository();

async function withTx<T>(
  ownerId: OwnerId,
  tx: Tx | undefined,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return tx ? fn(tx) : transaction(ownerId, fn);
}

async function decryptText(
  ownerId: OwnerId,
  table: string,
  column: string,
  value: Uint8Array | null,
): Promise<string | undefined> {
  if (!value) return undefined;
  return Buffer.from(await decrypt(ownerId, table, column, value)).toString("utf8");
}

async function decryptJson<T>(
  ownerId: OwnerId,
  table: string,
  column: string,
  value: Uint8Array,
): Promise<T> {
  const text = await decryptText(ownerId, table, column, value);
  return JSON.parse(text ?? "null") as T;
}

async function encryptText(
  ownerId: OwnerId,
  table: string,
  column: string,
  value: string,
): Promise<Buffer> {
  return Buffer.from(await encrypt(ownerId, table, column, Buffer.from(value, "utf8")));
}

async function encryptJson(
  ownerId: OwnerId,
  table: string,
  column: string,
  value: unknown,
): Promise<Buffer> {
  return encryptText(ownerId, table, column, JSON.stringify(value));
}

async function personFromRow(ownerId: OwnerId, row: PeopleRow): Promise<Person> {
  return {
    id: row.id,
    name: (await decryptText(ownerId, "people", "name_enc", row.name_enc)) ?? "",
    segment: row.segment ?? "personal",
    organization: (await decryptText(ownerId, "people", "organization_enc", row.organization_enc)) ?? null,
    roleTitle: (await decryptText(ownerId, "people", "role_title_enc", row.role_title_enc)) ?? null,
    sourceContext: (await decryptText(ownerId, "people", "source_context_enc", row.source_context_enc)) ?? null,
    starred: row.starred,
    avatarBg: row.avatar_bg,
    avatarFg: row.avatar_fg,
    relationshipId: row.relationship_id,
    cultureId: row.culture_id,
    since: await decryptText(ownerId, "people", "since_enc", row.since_enc),
    identityTags: await decryptJson<string[]>(ownerId, "people", "identity_tags_enc", row.identity_tags_enc),
    knownFacts: await decryptJson<PersonKnownFact[]>(ownerId, "people", "known_facts_enc", row.known_facts_enc),
    personalTaboos: await decryptJson<string[]>(ownerId, "people", "personal_taboos_enc", row.personal_taboos_enc),
    nextOccasionId: row.next_occasion_id,
    lastContactAt: row.last_contact_at_iso ?? undefined,
  };
}

async function occasionFromRow(ownerId: OwnerId, row: OccasionRow): Promise<OccasionNode> {
  return {
    id: row.id,
    personId: row.person_id,
    kind: row.kind,
    label: (await decryptText(ownerId, "occasion_nodes", "label_enc", row.label_enc)) ?? "",
    detail: await decryptText(ownerId, "occasion_nodes", "detail_enc", row.detail_enc),
    dateISO: row.date_iso,
    daysUntil: row.days_until,
    isPrimary: row.is_primary,
  };
}

function notImplemented(method: string): never {
  throw new Error(`PeopleRepository.${method} is not implemented yet.`);
}

export class PgPeopleRepository implements PeopleRepository {
  async listForOwner(ownerId: OwnerId, tx?: Tx): Promise<Person[]> {
    return withTx(ownerId, tx, async (activeTx) => {
      const result = await query<PeopleRow>(
        activeTx,
        `
          SELECT
            p.id::text,
            p.name_enc,
            p.segment,
            p.organization_enc,
            p.role_title_enc,
            p.source_context_enc,
            p.starred,
            p.avatar_bg,
            p.avatar_fg,
            p.relationship_id,
            p.culture_id,
            p.since_enc,
            p.identity_tags_enc,
            p.known_facts_enc,
            p.personal_taboos_enc,
            to_char(p.last_contact_at, 'YYYY-MM-DD') AS last_contact_at_iso,
            next_occ.id::text AS next_occasion_id
          FROM people p
          LEFT JOIN LATERAL (
            SELECT o.id
            FROM occasion_nodes o
            WHERE o.owner_id = p.owner_id
              AND o.person_id = p.id
              AND o.date_iso >= CURRENT_DATE
            ORDER BY o.date_iso ASC, o.id ASC
            LIMIT 1
          ) next_occ ON true
          WHERE p.owner_id = $1
          ORDER BY p.starred DESC, p.created_at ASC, p.id ASC
        `,
        [ownerId],
      );
      return Promise.all(result.rows.map((row) => personFromRow(ownerId, row)));
    });
  }

  async listWithRelations(ownerId: OwnerId, tx?: Tx): Promise<PeoplePayload> {
    return withTx(ownerId, tx, async (activeTx) => {
      const people = await this.listForOwner(ownerId, activeTx);
      const relationships = await catalog.listRelationships(ownerId, activeTx);
      const cultures = await catalog.listCultures(activeTx);
      const occasions = await this.listOccasionsForOwner(ownerId, activeTx);
      return { people, relationships, cultures, occasions };
    });
  }

  async findById(ownerId: OwnerId, personId: string, tx?: Tx): Promise<Person | null> {
    return withTx(ownerId, tx, async (activeTx) => {
      const result = await query<PeopleRow>(
        activeTx,
        `
          SELECT
            p.id::text,
            p.name_enc,
            p.segment,
            p.organization_enc,
            p.role_title_enc,
            p.source_context_enc,
            p.starred,
            p.avatar_bg,
            p.avatar_fg,
            p.relationship_id,
            p.culture_id,
            p.since_enc,
            p.identity_tags_enc,
            p.known_facts_enc,
            p.personal_taboos_enc,
            to_char(p.last_contact_at, 'YYYY-MM-DD') AS last_contact_at_iso,
            next_occ.id::text AS next_occasion_id
          FROM people p
          LEFT JOIN LATERAL (
            SELECT o.id
            FROM occasion_nodes o
            WHERE o.owner_id = p.owner_id
              AND o.person_id = p.id
              AND o.date_iso >= CURRENT_DATE
            ORDER BY o.date_iso ASC, o.id ASC
            LIMIT 1
          ) next_occ ON true
          WHERE p.owner_id = $1
            AND p.id = $2
          LIMIT 1
        `,
        [ownerId, personId],
      );
      return result.rows[0] ? personFromRow(ownerId, result.rows[0]) : null;
    });
  }

  async create(ownerId: OwnerId, input: PersonCreateInput, tx?: Tx): Promise<Person> {
    return withTx(ownerId, tx, async (activeTx) => {
      const result = await query<PeopleRow>(
        activeTx,
        `
          INSERT INTO people (
            owner_id,
            name_enc,
            segment,
            organization_enc,
            role_title_enc,
            source_context_enc,
            starred,
            avatar_bg,
            avatar_fg,
            relationship_id,
            culture_id,
            since_enc,
            identity_tags_enc,
            known_facts_enc,
            personal_taboos_enc,
            last_contact_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12,
            $13,
            $14,
            $15,
            $16
          )
          RETURNING
            id::text,
            name_enc,
            segment,
            organization_enc,
            role_title_enc,
            source_context_enc,
            starred,
            avatar_bg,
            avatar_fg,
            relationship_id,
            culture_id,
            since_enc,
            identity_tags_enc,
            known_facts_enc,
            personal_taboos_enc,
            to_char(last_contact_at, 'YYYY-MM-DD') AS last_contact_at_iso,
            NULL::text AS next_occasion_id
        `,
        [
          ownerId,
          await encryptText(ownerId, "people", "name_enc", input.name),
          input.segment ?? "personal",
          input.organization
            ? await encryptText(ownerId, "people", "organization_enc", input.organization)
            : null,
          input.roleTitle
            ? await encryptText(ownerId, "people", "role_title_enc", input.roleTitle)
            : null,
          input.sourceContext
            ? await encryptText(ownerId, "people", "source_context_enc", input.sourceContext)
            : null,
          input.starred ?? false,
          input.avatarBg,
          input.avatarFg,
          input.relationshipId,
          input.cultureId,
          input.since
            ? await encryptText(ownerId, "people", "since_enc", input.since)
            : null,
          await encryptJson(ownerId, "people", "identity_tags_enc", input.identityTags ?? []),
          await encryptJson(ownerId, "people", "known_facts_enc", input.knownFacts ?? []),
          await encryptJson(ownerId, "people", "personal_taboos_enc", input.personalTaboos ?? []),
          input.lastContactAt ?? null,
        ],
      );

      return personFromRow(ownerId, result.rows[0]);
    });
  }

  async update(_ownerId: OwnerId, _personId: string, _patch: PersonPatch, _tx?: Tx): Promise<Person> {
    return notImplemented("update");
  }

  async softDelete(_ownerId: OwnerId, _personId: string, _tx?: Tx): Promise<void> {
    return notImplemented("softDelete");
  }

  async listOccasions(ownerId: OwnerId, personId: string, tx?: Tx): Promise<OccasionNode[]> {
    return withTx(ownerId, tx, async (activeTx) => (
      this.listOccasionsForOwner(ownerId, activeTx, personId)
    ));
  }

  async findOccasionForPerson(
    ownerId: OwnerId,
    personId: string,
    occasionId: string,
    tx?: Tx,
  ): Promise<OccasionNode | null> {
    return withTx(ownerId, tx, async (activeTx) => {
      const rows = await this.occasionRows(ownerId, activeTx, {
        personId,
        occasionId,
      });
      return rows[0] ? occasionFromRow(ownerId, rows[0]) : null;
    });
  }

  async nextOccasionFor(ownerId: OwnerId, personId: string, tx?: Tx): Promise<OccasionNode | null> {
    return withTx(ownerId, tx, async (activeTx) => {
      const rows = await this.occasionRows(ownerId, activeTx, {
        personId,
        futureOnly: true,
        limit: 1,
      });
      return rows[0] ? occasionFromRow(ownerId, rows[0]) : null;
    });
  }

  async occasionsComingUp(ownerId: OwnerId, withinDays: number, tx?: Tx): Promise<OccasionNode[]> {
    return withTx(ownerId, tx, async (activeTx) => {
      const rows = await this.occasionRows(ownerId, activeTx, {
        futureOnly: true,
        withinDays,
      });
      return Promise.all(rows.map((row) => occasionFromRow(ownerId, row)));
    });
  }

  async upsertOccasion(
    _ownerId: OwnerId,
    _personId: string,
    _input: OccasionUpsertInput,
    _tx?: Tx,
  ): Promise<OccasionNode> {
    return notImplemented("upsertOccasion");
  }

  async removeOccasion(_ownerId: OwnerId, _occasionId: string, _tx?: Tx): Promise<void> {
    return notImplemented("removeOccasion");
  }

  private async listOccasionsForOwner(
    ownerId: OwnerId,
    tx: Tx,
    personId?: string,
  ): Promise<OccasionNode[]> {
    const rows = await this.occasionRows(ownerId, tx, { personId });
    return Promise.all(rows.map((row) => occasionFromRow(ownerId, row)));
  }

  private async occasionRows(
    ownerId: OwnerId,
    tx: Tx,
    filters: {
      personId?: string;
      occasionId?: string;
      futureOnly?: boolean;
      withinDays?: number;
      limit?: number;
    } = {},
  ): Promise<OccasionRow[]> {
    const values: unknown[] = [ownerId];
    const where = ["o.owner_id = $1"];

    if (filters.personId) {
      values.push(filters.personId);
      where.push(`o.person_id = $${values.length}`);
    }

    if (filters.occasionId) {
      values.push(filters.occasionId);
      where.push(`o.id = $${values.length}`);
    }

    if (filters.futureOnly) {
      where.push("o.date_iso >= CURRENT_DATE");
    }

    if (filters.withinDays !== undefined) {
      values.push(filters.withinDays);
      where.push(`o.date_iso <= CURRENT_DATE + ($${values.length}::int)`);
    }

    const limit = filters.limit ? `LIMIT ${filters.limit}` : "";

    const result = await query<OccasionRow>(
      tx,
      `
        SELECT
          o.id::text,
          o.person_id::text,
          o.kind,
          o.label_enc,
          o.detail_enc,
          to_char(o.date_iso, 'YYYY-MM-DD') AS date_iso,
          (o.date_iso - CURRENT_DATE)::int AS days_until,
          (o.id = primary_occ.id) AS is_primary
        FROM occasion_nodes o
        LEFT JOIN LATERAL (
          SELECT p.id
          FROM occasion_nodes p
          WHERE p.owner_id = o.owner_id
            AND p.person_id = o.person_id
            AND p.date_iso >= CURRENT_DATE
          ORDER BY p.date_iso ASC, p.id ASC
          LIMIT 1
        ) primary_occ ON true
        WHERE ${where.join(" AND ")}
        ORDER BY o.date_iso ASC, o.id ASC
        ${limit}
      `,
      values,
    );
    return result.rows;
  }
}

export function createPeopleRepository(): PeopleRepository {
  return new PgPeopleRepository();
}
