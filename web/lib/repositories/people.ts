// PeopleRepository — per-user CRUD over `people` + `occasion_nodes`.
//
// Runtime read implementation: people.server.ts.
//
// Conventions:
//   - Every method takes `ownerId` as the first argument. RLS already
//     filters; explicit ownerId is defence in depth and self-documenting.
//   - Plaintext domain types in and out. Encryption stays inside the impl.
//   - Soft-delete only; the schema TODO around `deleted_at` lives here.
//
// Caller mapping:
//   listForOwner            → /api/people GET (server)
//   listWithRelations       → /api/people GET — single batched query
//   findById                → /api/drafts POST (internal); future drawer GET
//   create / update / archive → "Add contact" / drawer maintenance routes
//   listOccasions           → drawer load (internal)
//   findOccasion            → /api/drafts POST (internal)
//   nextOccasionFor         → resolves Person.nextOccasionId at read time
//   occasionsComingUp       → Home count, scheduler queries
//   upsertOccasion / removeOccasion → future drawer / first-run setup

import type {
  ID,
  OccasionNode,
  PeoplePayload,
  Person,
} from "../domain";
import type {
  OccasionUpsertInput,
  OwnerId,
  PersonCreateInput,
  PersonPatch,
  PeopleReadOptions,
  Tx,
} from "./types";

export interface PeopleRepository {
  // ── People ──────────────────────────────────────────────────────────────

  /** Plain list of people the caller owns. Defaults to active rows. */
  listForOwner(ownerId: OwnerId, tx?: Tx, options?: PeopleReadOptions): Promise<Person[]>;

  /**
   * Batched fetch returning the same payload the API responds with:
   * people + the catalog rows they reference + every occasion. One query plan,
   * so the workspace top-bar can render without N+1.
   *
   * `Person.nextOccasionId` is hydrated by this method — it's derived as the
   * earliest future occasion per person.
   */
  listWithRelations(ownerId: OwnerId, tx?: Tx, options?: PeopleReadOptions): Promise<PeoplePayload>;

  /** Returns `null` if not owned by the caller or not found. */
  findById(ownerId: OwnerId, personId: ID, tx?: Tx): Promise<Person | null>;

  create(ownerId: OwnerId, input: PersonCreateInput, tx?: Tx): Promise<Person>;

  update(ownerId: OwnerId, personId: ID, patch: PersonPatch, tx?: Tx): Promise<Person>;

  /** Sets `archived_at`; row is retained so History rows keep their recipient_name. */
  archive(ownerId: OwnerId, personId: ID, tx?: Tx): Promise<Person>;

  /** Clears `archived_at`; row re-enters default People/Home reads. */
  restore(ownerId: OwnerId, personId: ID, tx?: Tx): Promise<Person>;

  /** Backward-compatible alias for older call sites. */
  softDelete(ownerId: OwnerId, personId: ID, tx?: Tx): Promise<void>;

  // ── Occasions ───────────────────────────────────────────────────────────

  listOccasions(ownerId: OwnerId, personId: ID, tx?: Tx): Promise<OccasionNode[]>;

  /**
   * Lookup a single occasion. Ownership is enforced by both RLS and the
   * composite FK `(person_id, owner_id) → people(id, owner_id)`.
   */
  findOccasionForPerson(
    ownerId: OwnerId,
    personId: ID,
    occasionId: ID,
    tx?: Tx,
  ): Promise<OccasionNode | null>;

  /** Earliest future occasion for a person; `null` if none. */
  nextOccasionFor(ownerId: OwnerId, personId: ID, tx?: Tx): Promise<OccasionNode | null>;

  /**
   * Cross-person sweep for the Home "dates coming up" count and the
   * reminder scheduler. `withinDays` defines the window from today.
   */
  occasionsComingUp(ownerId: OwnerId, withinDays: number, tx?: Tx): Promise<OccasionNode[]>;

  upsertOccasion(
    ownerId: OwnerId,
    personId: ID,
    input: OccasionUpsertInput,
    tx?: Tx,
  ): Promise<OccasionNode>;

  removeOccasion(ownerId: OwnerId, occasionId: ID, tx?: Tx): Promise<void>;
}
