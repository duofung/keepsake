// Shared types for the repository layer. Plumbing only — no business types
// (those live in lib/domain.ts).
//
// Status: DESIGN ONLY. No DB client is imported anywhere; nothing here is
// instantiated. Implementations land when the DB client is chosen.

import type {
  AttachedCard,
  Channel,
  DeliveryStatus,
  DraftParagraph,
  DraftQuickAction,
  ID,
  OccasionKind,
  PersonKnownFact,
  Tone,
  CultureId,
} from "../domain";

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `OwnerId` is a `User.id` (the row owner under RLS). It is brand-typed so a
 * call like `people.findById(personId, otherPersonId)` becomes a type error
 * — you must thread the owner explicitly.
 */
export type OwnerId = ID & { readonly __brand: "OwnerId" };

// ─────────────────────────────────────────────────────────────────────────────
// Transaction handle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Opaque transaction context passed to repo methods as an optional last arg.
 * When omitted, the repo opens and commits its own implicit transaction.
 *
 * Preconditions any `Tx` must satisfy at open time:
 *   - role is the app role (not BYPASSRLS).
 *   - `SET LOCAL app.user_id = '<uuid>'` has been issued for `OwnerId`.
 *
 * The interface stays opaque so the choice of `pg`, `postgres.js`, or a
 * future driver doesn't leak into the call sites.
 */
export interface Tx {
  readonly __tx: unique symbol;
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export type RepoErrorKind =
  | "not-found"
  | "permission-denied"
  | "conflict"          // unique constraint, write contention
  | "validation"        // input failed a CHECK constraint at the DB layer
  | "unavailable";      // DB down, timeout

/**
 * Typed error union for route handlers to map to HTTP status codes without
 * inspecting message strings. `not-found` covers both "doesn't exist" and
 * "exists but isn't yours" — never distinguished externally.
 */
export interface RepoError extends Error {
  readonly kind: RepoErrorKind;
  readonly cause?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Write input shapes
//
// Each input is the domain type minus the server-derived fields (id, created_at).
// They live here, not in domain.ts, because they are repo-internal —
// the API contract is whatever the route handler accepts before calling save().
// ─────────────────────────────────────────────────────────────────────────────

export interface PersonCreateInput {
  name: string;
  starred?: boolean;
  avatarBg: string;
  avatarFg: string;
  relationshipId: ID;
  cultureId: CultureId;
  since?: string;
  identityTags?: string[];
  knownFacts?: PersonKnownFact[];
  personalTaboos?: string[];
  lastContactAt?: string;
}

export type PersonPatch = Partial<PersonCreateInput>;

export interface OccasionUpsertInput {
  id?: ID;                  // present → update; absent → insert
  kind: OccasionKind;
  label: string;
  detail?: string;
  dateISO: string;
  recurrence?: "yearly" | "lunar-yearly" | "once";
}

export interface MessageDraftSaveInput {
  personId: ID;
  occasionId: ID | null;
  tone: Tone;
  toneLabel: string;
  alternativeTones: { tone: Tone; label: string }[];
  subject: string;
  paragraphs: DraftParagraph[];
  attachedCard: AttachedCard | null;
  quickActions: DraftQuickAction[];
  assistantNote: string;
  userInstruction: string;
  promptHash: string;
  modelProvider?: string;   // 'mock' today; 'anthropic' later
  modelVersion?: string;
}

export interface DeliveryEnqueueInput {
  personId: ID | null;      // null after the person was soft-deleted
  draftId: ID | null;
  recipientName: string;
  recipientEmail?: string;
  recipientAddress?: string;
  occasionKind: OccasionKind;
  occasionLabel: string;
  channel: Channel;
  scheduledFor?: string;    // ISO; absent → "send now"
}

export interface DeliveriesListOptions {
  limit?: number;
  beforeISO?: string;       // pagination cursor
}

/**
 * Worker-facing delivery row. This intentionally is not the public `Delivery`
 * domain type because a sender needs contact fields that the History UI should
 * never receive.
 */
export interface DeliveryQueueItem {
  id: ID;
  ownerId: OwnerId;
  personId: ID | null;
  draftId: ID | null;
  recipientName: string;
  recipientEmail?: string;
  recipientAddress?: string;
  occasionKind: OccasionKind;
  occasionLabel: string;
  channel: Channel;
  scheduledForISO?: string;
  status: "queued";
}

// ─────────────────────────────────────────────────────────────────────────────
// Gmail sender account storage
// ─────────────────────────────────────────────────────────────────────────────

export type GmailAccountStatus = "connected" | "expired";

/**
 * Decrypted account metadata safe to return to server auth/Profile/Workspace
 * orchestration. It deliberately never includes refresh or access tokens.
 */
export interface GmailAccount {
  id: ID;
  ownerId: OwnerId;
  email: string;
  status: GmailAccountStatus;
  scopes: string[];
  isPrimary: boolean;
  lastConnectedAtISO: string;
  refreshTokenExpiresAtISO: string | null;
  lastError: string | null;
  createdAtISO: string;
  updatedAtISO: string;
}

export interface GmailAccountUpsertInput {
  email: string;
  scopes: string[];
  refreshToken: string;
  refreshTokenExpiresAtISO?: string | null;
}

export interface GmailAccountMarkExpiredInput {
  lastError?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports for convenience inside the repo layer
// ─────────────────────────────────────────────────────────────────────────────

export type { DeliveryStatus };
