import "server-only";

import { randomUUID } from "node:crypto";
import type { ContactSegment, CultureId, Person, PersonKnownFact } from "@/lib/domain";
import type { PersonCreateInput } from "@/lib/repositories";
import { dataSource } from "@/lib/server/auth/current-user.server";
import { createDbPerson } from "./db.server";
import { createMockPerson } from "./mock.server";

const CULTURE_IDS = new Set<CultureId>([
  "chinese",
  "malay-muslim",
  "indian-hindu",
  "none",
]);

const CONTACT_SEGMENTS = new Set<ContactSegment>([
  "client",
  "partner",
  "prospect",
  "investor",
  "personal",
]);

const avatarPalette = [
  { bg: "#D9EAFA", fg: "#4F83BA" },
  { bg: "#F9DDD2", fg: "#C87855" },
  { bg: "#DDD4F0", fg: "#856FC0" },
  { bg: "#D8F0E6", fg: "#5FA77D" },
  { bg: "#F3D7E8", fg: "#B86795" },
  { bg: "#F7E7BE", fg: "#B68221" },
];

export type PeopleCreateResult =
  | { ok: true; person: Person }
  | {
      ok: false;
      status: 400 | 500;
      code: "invalid_request" | "invalid_reference" | "unavailable";
      error: string;
    };

type NormalizedPersonCreate = PersonCreateInput & {
  readonly previewId: string;
};

type NormalizeResult =
  | { ok: true; input: NormalizedPersonCreate }
  | PeopleCreateError;

type PeopleCreateError = Extract<PeopleCreateResult, { ok: false }>;

export async function createPersonFromRequest(input: unknown): Promise<PeopleCreateResult> {
  const normalized = normalizePersonCreate(input);
  if (!normalized.ok) return normalized;

  return dataSource() === "db"
    ? createDbPerson(normalized.input)
    : createMockPerson(normalized.input);
}

function normalizePersonCreate(input: unknown): NormalizeResult {
  if (!isRecord(input)) {
    return invalid("Request body must be an object.");
  }

  const name = stringField(input.name).trim();
  const segment = normalizeSegment(input.segment);
  const organization = optionalString(input.organization, 140);
  const roleTitle = optionalString(input.roleTitle, 140);
  const sourceContext = optionalString(input.sourceContext ?? input.since, 220);
  const cultureId = stringField(input.cultureId).trim() || "none";
  const note = optionalString(input.note, 700);
  const starred = input.starred === undefined ? false : input.starred === true;

  if (!name) return invalid("name is required.");
  if (name.length > 100) return invalid("name is too long.");
  if (!segment) return invalid("segment is not supported.");
  const relationshipId = stringField(input.relationshipId).trim() || relationshipForSegment(segment);
  if (!relationshipId) return invalid("relationshipId is required.");
  if (!cultureId) return invalid("cultureId is required.");
  if (!CULTURE_IDS.has(cultureId as CultureId)) {
    return invalid("cultureId is not supported.");
  }
  if (input.starred !== undefined && typeof input.starred !== "boolean") {
    return invalid("starred must be a boolean.");
  }

  const knownFacts: PersonKnownFact[] = note
    ? [{ text: note, isLead: true }]
    : [{ text: "New relationship to learn about.", isLead: true }];
  const palette = avatarFor(name);

  return {
    ok: true,
    input: {
      previewId: `local-${randomUUID()}`,
      name,
      segment,
      organization: organization || null,
      roleTitle: roleTitle || null,
      sourceContext: sourceContext || null,
      starred,
      avatarBg: palette.bg,
      avatarFg: palette.fg,
      relationshipId,
      cultureId: cultureId as CultureId,
      since: sourceContext || undefined,
      identityTags: sourceContext ? [sourceContext] : [],
      knownFacts,
      personalTaboos: [],
      lastContactAt: new Date().toISOString().slice(0, 10),
    },
  };
}

function invalid(error: string): PeopleCreateError {
  return { ok: false, status: 400, code: "invalid_request", error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeSegment(value: unknown): ContactSegment | null {
  if (value === undefined || value === null || value === "") return "personal";
  if (typeof value !== "string") return null;
  const segment = value.trim();
  return CONTACT_SEGMENTS.has(segment as ContactSegment) ? segment as ContactSegment : null;
}

function relationshipForSegment(segment: ContactSegment): string {
  return segment === "partner" ? "rel-partner" : "rel-friend";
}

function optionalString(value: unknown, maxLength: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function avatarFor(name: string) {
  const seed = Array.from(name).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return avatarPalette[seed % avatarPalette.length];
}
