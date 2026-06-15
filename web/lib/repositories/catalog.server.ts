import "server-only";

import type { QueryResultRow } from "pg";
import type { CultureId, CultureRule, ID, Relationship } from "../domain";
import { query, transaction } from "@/lib/server/db/transaction.server";
import type { CatalogRepository } from "./catalog";
import type { OwnerId, Tx } from "./types";

type RelationshipRow = QueryResultRow & {
  id: string;
  kind: Relationship["kind"];
  group_name: Relationship["group"];
  label: string;
  palette_bg: string;
  palette_fg: string;
};

type CultureRow = QueryResultRow & {
  id: CultureId;
  label: string;
  dot_color: string;
  festivals: CultureRule["festivals"];
  palette: string[];
  greetings: string[];
  taboos: string[];
};

function relationshipFromRow(row: RelationshipRow): Relationship {
  return {
    id: row.id,
    kind: row.kind,
    group: row.group_name,
    label: row.label,
    paletteBg: row.palette_bg,
    paletteFg: row.palette_fg,
  };
}

function cultureFromRow(row: CultureRow): CultureRule {
  return {
    id: row.id,
    label: row.label,
    dotColor: row.dot_color,
    festivals: row.festivals,
    palette: row.palette,
    greetings: row.greetings,
    taboos: row.taboos,
  };
}

async function withTx<T>(
  ownerId: OwnerId | null,
  tx: Tx | undefined,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return tx ? fn(tx) : transaction(ownerId, fn);
}

export class PgCatalogRepository implements CatalogRepository {
  async listRelationships(ownerId: OwnerId, tx?: Tx): Promise<Relationship[]> {
    return withTx(ownerId, tx, async (activeTx) => {
      const result = await query<RelationshipRow>(
        activeTx,
        `
          SELECT id, kind, group_name, label, palette_bg, palette_fg
          FROM relationships
          ORDER BY
            CASE WHEN owner_id IS NULL THEN 0 ELSE 1 END,
            group_name,
            label,
            id
        `,
      );
      return result.rows.map(relationshipFromRow);
    });
  }

  async listCultures(tx?: Tx): Promise<CultureRule[]> {
    return withTx(null, tx, async (activeTx) => {
      const result = await query<CultureRow>(
        activeTx,
        `
          SELECT id, label, dot_color, festivals::text[] AS festivals, palette, greetings, taboos
          FROM cultures
          ORDER BY label, id
        `,
      );
      return result.rows.map(cultureFromRow);
    });
  }

  async getRelationship(ownerId: OwnerId, id: ID, tx?: Tx): Promise<Relationship | null> {
    return withTx(ownerId, tx, async (activeTx) => {
      const result = await query<RelationshipRow>(
        activeTx,
        `
          SELECT id, kind, group_name, label, palette_bg, palette_fg
          FROM relationships
          WHERE id = $1
          LIMIT 1
        `,
        [id],
      );
      return result.rows[0] ? relationshipFromRow(result.rows[0]) : null;
    });
  }

  async getCulture(id: CultureId, tx?: Tx): Promise<CultureRule | null> {
    return withTx(null, tx, async (activeTx) => {
      const result = await query<CultureRow>(
        activeTx,
        `
          SELECT id, label, dot_color, festivals::text[] AS festivals, palette, greetings, taboos
          FROM cultures
          WHERE id = $1
          LIMIT 1
        `,
        [id],
      );
      return result.rows[0] ? cultureFromRow(result.rows[0]) : null;
    });
  }
}

export function createCatalogRepository(): CatalogRepository {
  return new PgCatalogRepository();
}
