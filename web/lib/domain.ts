// Domain types for Keepsake. Intentionally close to a future Postgres schema:
// every visible string is a value, no HTML, presentation concerns live elsewhere.

export type ID = string;

// ─────────────────────────────────────────────────────────────────────────────
// Business contact layer
// ─────────────────────────────────────────────────────────────────────────────

export type ContactSegment =
  | "client"
  | "partner"
  | "prospect"
  | "investor"
  | "personal";

// ─────────────────────────────────────────────────────────────────────────────
// Relationship — partner / mother / friend / colleague…
// ─────────────────────────────────────────────────────────────────────────────

export type RelationshipKind =
  | "partner"
  | "mother"
  | "father"
  | "sibling"
  | "child"
  | "close-friend"
  | "friend"
  | "colleague"
  | "mentor"
  | "other";

export type RelationshipGroup = "Partner" | "Family" | "Friends" | "Colleagues";

export interface Relationship {
  id: ID;
  kind: RelationshipKind;
  group: RelationshipGroup;
  label: string;           // "Partner", "Close friend"
  paletteBg: string;       // chip background hex
  paletteFg: string;       // chip foreground hex
}

// ─────────────────────────────────────────────────────────────────────────────
// CultureRule — the strategic asset. Drives festivals, palette, greetings, taboos.
// ─────────────────────────────────────────────────────────────────────────────

export type CultureId =
  | "chinese"
  | "malay-muslim"
  | "indian-hindu"
  | "none";

export interface CultureRule {
  id: CultureId;
  label: string;           // "Chinese", "Malay · Muslim"
  dotColor: string;        // small dot used wherever culture is shown
  festivals: OccasionKind[];
  palette: string[];       // hex colors a card generator may use
  greetings: string[];     // canonical greetings, machine-readable
  taboos: string[];        // short, language-agnostic rules
}

// ─────────────────────────────────────────────────────────────────────────────
// OccasionNode — a date Keepsake is watching for a person.
// ─────────────────────────────────────────────────────────────────────────────

export type OccasionKind =
  | "anniversary"
  | "birthday"
  | "hari-raya"
  | "lunar-new-year"
  | "deepavali"
  | "qingming"
  | "check-in"
  | "custom";

export interface OccasionNode {
  id: ID;
  personId: ID;
  kind: OccasionKind;
  label: string;           // "Anniversary", "Hari Raya Aidilfitri"
  detail?: string;         // "12 years today", "turning 62"
  dateISO: string;         // YYYY-MM-DD (canonical)
  daysUntil: number;       // derived in production; mocked here
  isPrimary: boolean;      // is this the next occasion to act on?
}

// ─────────────────────────────────────────────────────────────────────────────
// Person
// ─────────────────────────────────────────────────────────────────────────────

export interface PersonKnownFact {
  text: string;
  isLead?: boolean;        // first short line shown in bold
}

export interface Person {
  id: ID;
  name: string;
  segment: ContactSegment; // business-first segment; legacy rows default to personal
  organization: string | null;
  roleTitle: string | null;
  sourceContext: string | null;
  starred: boolean;        // "closest circle"
  avatarBg: string;
  avatarFg: string;
  relationshipId: ID;
  cultureId: CultureId;
  since?: string;          // "together 12 years", "since 2019"
  identityTags: string[];  // free-form, e.g. "met at university"
  knownFacts: PersonKnownFact[];
  personalTaboos: string[];// person-specific notes beyond culture rules
  nextOccasionId: ID | null;
  lastContactAt?: string;  // ISO — when no occasion, drives "last note · 2 mo ago"
  nextFollowUpAt?: string; // ISO date for the lightweight maintenance follow-up target
  archivedAt?: string;     // ISO timestamp for soft archive; history rows remain
}

// ─────────────────────────────────────────────────────────────────────────────
// MessageDraft — what the AI returns; what the compose view renders.
// ─────────────────────────────────────────────────────────────────────────────

export type Tone =
  | "tender-intimate"
  | "playful"
  | "heartfelt"
  | "warm-caring"
  | "warm-festive"
  | "warm-easy"
  | "light-warm";

export interface DraftParagraph {
  text: string;            // plain text, no HTML
  highlights?: string[];   // substrings to render with the "hl" style
}

export interface DraftQuickAction {
  label: string;           // "More flirty"
  prompt: string;          // user-instruction sent to the API
  iconHint: string;        // icon name; presentation layer only
}

export interface AttachedCard {
  styleLabel: string;      // "Tender rose tones"
  description: string;     // "AI-made for you two"
  // presentation-only hints stay outside MessageDraft (see lib/presentation)
  paletteHint: string;     // e.g. "rose", "festive-green"; renderer picks gradient
  iconHint: string;
}

export interface MessageDraft {
  id: ID;
  personId: ID;
  occasionId: ID | null;
  tone: Tone;
  toneLabel: string;       // human label, denormalized for convenience
  alternativeTones: { tone: Tone; label: string }[];
  subject: string;
  paragraphs: DraftParagraph[];
  attachedCard: AttachedCard | null;
  quickActions: DraftQuickAction[];
  assistantNote: string;   // what the AI says in chat about this revision
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery — history of what was sent.
// ─────────────────────────────────────────────────────────────────────────────

export type Channel = "email" | "post";
export type DeliveryStatus =
  | "queued"
  | "sending"   // worker claimed the row and is calling Gmail
  | "sent"
  | "delivered"
  | "opened"
  | "failed";   // terminal worker failure (no retry queue today)

export interface Delivery {
  id: ID;
  personId: ID | null;      // who it went to; null when the original person row is gone or the recipient was never in People
  recipientName: string;    // denormalized for history rendering
  occasionKind: OccasionKind;
  occasionLabel: string;    // "Lunar New Year", "Valentine's note"
  channel: Channel;
  sentAtISO: string;
  status: DeliveryStatus;
}

// `DeliveryRequest` is the wire shape accepted by `POST /api/deliveries`.
// Intentionally minimal: the server resolves the recipient name, draft id,
// and occasion metadata from the owner-scoped person/occasion/draft rows.
//
// `recipientEmail` is the only piece of recipient identity the client
// supplies, and only for the email channel — Keepsake's `Person` model has
// no email today, so "who to send to" is named at send time and stored on
// the queued row (not on the person). When `channel === "post"` this field
// is ignored.
export interface DeliveryRequest {
  personId: ID;
  occasionId: ID | null;
  channel: Channel;
  recipientEmail?: string;
}

// `QueuedDelivery` is the "I queued it, here's the receipt" shape returned
// by enqueue. It is deliberately not a `Delivery` because `Delivery` carries
// a non-null `sentAtISO` and is the History/post-send shape — a queued row
// has not been sent and `sent_at` is null in the DB.
export interface QueuedDelivery {
  id: ID;
  personId: ID;
  occasionId: ID | null;
  draftId: ID;
  channel: Channel;
  status: "queued";
  scheduledForISO: string | null;
  createdAtISO: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// API contracts
// ─────────────────────────────────────────────────────────────────────────────

export interface PeoplePayload {
  people: Person[];
  relationships: Relationship[];
  cultures: CultureRule[];
  occasions: OccasionNode[];
}

export interface DraftRequest {
  personId: ID;
  occasionId: ID | null;
  userInstruction: string;  // empty string => generate initial draft
}
