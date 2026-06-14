// CatalogRepository — access to the system catalog tables.
//
// Runtime implementation: catalog.server.ts.
//
// Scope: relationships (system + user-custom rows) and cultures (system only
// for now). Cultures are safe to memoise for the lifetime of a process;
// relationship reads are owner-aware because custom rows share the table.
//
// Caller mapping:
//   listRelationships(ownerId) → /api/people GET
//   listCultures()       → /api/people GET
//   getRelationship(ownerId, id) → /api/drafts POST (internal hydration)
//   getCulture(id)       → /api/drafts POST (internal hydration)

import type { CultureId, CultureRule, ID, Relationship } from "../domain";
import type { OwnerId, Tx } from "./types";

export interface CatalogRepository {
  /** All relationships visible to the caller: system rows + own customs. */
  listRelationships(ownerId: OwnerId, tx?: Tx): Promise<Relationship[]>;

  /** All cultures. Catalog is global today. */
  listCultures(tx?: Tx): Promise<CultureRule[]>;

  /** Returns `null` when the id is not found or not visible to the owner. */
  getRelationship(ownerId: OwnerId, id: ID, tx?: Tx): Promise<Relationship | null>;

  /** Returns `null` when the id is not found. */
  getCulture(id: CultureId, tx?: Tx): Promise<CultureRule | null>;
}
