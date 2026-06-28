import "server-only";

import type { ContactSegment, ContactTouchpointType, Person, PersonKnownFact } from "@/lib/domain";
import type { PersonPatch } from "@/lib/repositories";
import { dataSource } from "@/lib/server/auth/current-user.server";
import {
  archiveDbPerson,
  logDbTouchpoint,
  markDbFollowUpDone,
  restoreDbPerson,
  setDbNextFollowUp,
  snoozeDbFollowUp,
  updateDbPerson,
} from "./db.server";
import {
  archiveMockPerson,
  logMockTouchpoint,
  markMockFollowUpDone,
  restoreMockPerson,
  setMockNextFollowUp,
  snoozeMockFollowUp,
  updateMockPerson,
} from "./mock.server";

const CONTACT_SEGMENTS = new Set<ContactSegment>([
  "client",
  "partner",
  "prospect",
  "investor",
  "personal",
]);

const TOUCHPOINT_TYPES = new Set<ContactTouchpointType>([
  "call",
  "email",
  "meeting",
  "message",
  "note",
  "other",
]);

export type PeopleMaintenanceResult =
  | { ok: true; person: Person }
  | {
      ok: false;
      status: 400 | 404 | 500;
      code: "invalid_request" | "not_found" | "unavailable";
      error: string;
    };

export async function updatePersonFromRequest(
  personId: string,
  input: unknown,
): Promise<PeopleMaintenanceResult> {
  const normalized = normalizePersonPatch(input);
  if (!normalized.ok) return normalized;

  return dataSource() === "db"
    ? updateDbPerson(personId, normalized.patch)
    : updateMockPerson(personId, normalized.patch);
}

export async function archivePersonFromRequest(personId: string): Promise<PeopleMaintenanceResult> {
  return dataSource() === "db"
    ? archiveDbPerson(personId)
    : archiveMockPerson(personId);
}

export async function restorePersonFromRequest(personId: string): Promise<PeopleMaintenanceResult> {
  return dataSource() === "db"
    ? restoreDbPerson(personId)
    : restoreMockPerson(personId);
}

export async function setNextFollowUpFromRequest(
  personId: string,
  input: unknown,
): Promise<PeopleMaintenanceResult> {
  const normalized = normalizeFollowUpDate(input);
  if (!normalized.ok) return normalized;

  return dataSource() === "db"
    ? setDbNextFollowUp(personId, normalized.date)
    : setMockNextFollowUp(personId, normalized.date);
}

export async function markFollowUpDoneFromRequest(personId: string): Promise<PeopleMaintenanceResult> {
  return dataSource() === "db"
    ? markDbFollowUpDone(personId)
    : markMockFollowUpDone(personId);
}

export async function snoozeFollowUpFromRequest(
  personId: string,
  input: unknown,
): Promise<PeopleMaintenanceResult> {
  const normalized = normalizeFollowUpDate(input);
  if (!normalized.ok) return normalized;

  return dataSource() === "db"
    ? snoozeDbFollowUp(personId, normalized.date)
    : snoozeMockFollowUp(personId, normalized.date);
}

export async function logTouchpointFromRequest(
  personId: string,
  input: unknown,
): Promise<PeopleMaintenanceResult> {
  const normalized = normalizeTouchpointInput(input);
  if (!normalized.ok) return normalized;

  return dataSource() === "db"
    ? logDbTouchpoint(personId, normalized.touchType, normalized.occurredAt)
    : logMockTouchpoint(personId, normalized.touchType, normalized.occurredAt);
}

function normalizePersonPatch(input: unknown):
  | { ok: true; patch: PersonPatch }
  | Extract<PeopleMaintenanceResult, { ok: false }> {
  if (!isRecord(input)) return invalid("Request body must be an object.");

  const patch: PersonPatch = {};

  if ("name" in input) {
    const name = requiredString(input.name).trim();
    if (!name) return invalid("name is required.");
    if (name.length > 100) return invalid("name is too long.");
    patch.name = name;
  }

  if ("segment" in input) {
    if (typeof input.segment !== "string") return invalid("segment must be a string.");
    const segment = input.segment.trim();
    if (!CONTACT_SEGMENTS.has(segment as ContactSegment)) return invalid("segment is not supported.");
    patch.segment = segment as ContactSegment;
  }

  const organization = nullableStringField(input, "organization", 140);
  if (!organization.ok) return organization;
  if (organization.present) patch.organization = organization.value;

  const roleTitle = nullableStringField(input, "roleTitle", 140);
  if (!roleTitle.ok) return roleTitle;
  if (roleTitle.present) patch.roleTitle = roleTitle.value;

  const sourceContext = nullableStringField(input, "sourceContext", 220);
  if (!sourceContext.ok) return sourceContext;
  if (sourceContext.present) patch.sourceContext = sourceContext.value;

  if ("note" in input || "notes" in input) {
    const noteValue = "note" in input ? input.note : input.notes;
    if (noteValue !== null && typeof noteValue !== "string") return invalid("note must be a string or null.");
    const note = typeof noteValue === "string" ? noteValue.trim().slice(0, 900) : "";
    patch.knownFacts = note ? [{ text: note, isLead: true } satisfies PersonKnownFact] : [];
  }

  if ("lastContactAt" in input) {
    const value = nullableDate(input.lastContactAt, "lastContactAt");
    if (!value.ok) return value;
    patch.lastContactAt = value.value;
  }

  if ("lastTouchpointType" in input) {
    const value = nullableTouchpointType(input.lastTouchpointType, "lastTouchpointType");
    if (!value.ok) return value;
    patch.lastTouchpointType = value.value;
  }

  if ("nextFollowUpAt" in input) {
    const value = nullableDate(input.nextFollowUpAt, "nextFollowUpAt");
    if (!value.ok) return value;
    patch.nextFollowUpAt = value.value;
  }

  if ("starred" in input) {
    if (typeof input.starred !== "boolean") return invalid("starred must be a boolean.");
    patch.starred = input.starred;
  }

  if (Object.keys(patch).length === 0) return invalid("No supported fields to update.");
  return { ok: true, patch };
}

function normalizeFollowUpDate(input: unknown):
  | { ok: true; date: string }
  | Extract<PeopleMaintenanceResult, { ok: false }> {
  if (!isRecord(input)) return invalid("Request body must be an object.");
  const rawDate = "nextFollowUpAt" in input ? input.nextFollowUpAt : input.date;
  const value = nullableDate(rawDate, "nextFollowUpAt");
  if (!value.ok) return value;
  if (!value.value) return invalid("nextFollowUpAt is required.");
  return { ok: true, date: value.value };
}

function normalizeTouchpointInput(input: unknown):
  | { ok: true; touchType: ContactTouchpointType; occurredAt?: string }
  | Extract<PeopleMaintenanceResult, { ok: false }> {
  if (!isRecord(input)) return invalid("Request body must be an object.");
  const touchType = nullableTouchpointType(input.touchType, "touchType");
  if (!touchType.ok) return touchType;
  if (!touchType.value) return invalid("touchType is required.");

  if (!("occurredAt" in input)) {
    return { ok: true, touchType: touchType.value };
  }

  const occurredAt = nullableDate(input.occurredAt, "occurredAt");
  if (!occurredAt.ok) return occurredAt;
  return {
    ok: true,
    touchType: touchType.value,
    occurredAt: occurredAt.value ?? undefined,
  };
}

function nullableStringField(
  input: Record<string, unknown>,
  key: string,
  maxLength: number,
):
  | { ok: true; present: false }
  | { ok: true; present: true; value: string | null }
  | Extract<PeopleMaintenanceResult, { ok: false }> {
  if (!(key in input)) return { ok: true, present: false };
  const value = input[key];
  if (value === null) return { ok: true, present: true, value: null };
  if (typeof value !== "string") return invalid(`${key} must be a string or null.`);
  const trimmed = value.trim().slice(0, maxLength);
  return { ok: true, present: true, value: trimmed || null };
}

function nullableDate(
  value: unknown,
  fieldName: string,
):
  | { ok: true; value: string | null }
  | Extract<PeopleMaintenanceResult, { ok: false }> {
  if (value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return invalid(`${fieldName} must be a YYYY-MM-DD string or null.`);
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return invalid(`${fieldName} must be a YYYY-MM-DD string or null.`);
  }
  const date = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== trimmed) {
    return invalid(`${fieldName} must be a valid date.`);
  }
  return { ok: true, value: trimmed };
}

function nullableTouchpointType(
  value: unknown,
  fieldName: string,
):
  | { ok: true; value: ContactTouchpointType | null }
  | Extract<PeopleMaintenanceResult, { ok: false }> {
  if (value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return invalid(`${fieldName} must be a supported touchpoint type or null.`);
  const trimmed = value.trim();
  if (!TOUCHPOINT_TYPES.has(trimmed as ContactTouchpointType)) {
    return invalid(`${fieldName} is not supported.`);
  }
  return { ok: true, value: trimmed as ContactTouchpointType };
}

function invalid(error: string): Extract<PeopleMaintenanceResult, { ok: false }> {
  return { ok: false, status: 400, code: "invalid_request", error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
