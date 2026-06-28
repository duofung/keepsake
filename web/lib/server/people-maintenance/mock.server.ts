import "server-only";

import type { ContactTouchpointType, Person } from "@/lib/domain";
import type { PersonPatch } from "@/lib/repositories";
import { people } from "@/lib/mock";
import type { PeopleMaintenanceResult } from "./index.server";

export async function updateMockPerson(
  personId: string,
  patch: PersonPatch,
): Promise<PeopleMaintenanceResult> {
  const person = people.find((item) => item.id === personId && !item.archivedAt);
  if (!person) return notFound();

  applyPatch(person, patch);
  return { ok: true, person };
}

export async function archiveMockPerson(personId: string): Promise<PeopleMaintenanceResult> {
  const person = people.find((item) => item.id === personId && !item.archivedAt);
  if (!person) return notFound();

  person.archivedAt = new Date().toISOString();
  return { ok: true, person };
}

export async function restoreMockPerson(personId: string): Promise<PeopleMaintenanceResult> {
  const person = people.find((item) => item.id === personId);
  if (!person) return notFound();
  if (!person.archivedAt) {
    return {
      ok: false,
      status: 400,
      code: "invalid_request",
      error: "Person is already active.",
    };
  }

  delete person.archivedAt;
  return { ok: true, person };
}

export async function setMockNextFollowUp(personId: string, date: string): Promise<PeopleMaintenanceResult> {
  return updateMockPerson(personId, { nextFollowUpAt: date });
}

export async function markMockFollowUpDone(personId: string): Promise<PeopleMaintenanceResult> {
  return updateMockPerson(personId, {
    lastContactAt: todayISO(),
    lastTouchpointType: "note",
    nextFollowUpAt: null,
  });
}

export async function snoozeMockFollowUp(personId: string, date: string): Promise<PeopleMaintenanceResult> {
  return updateMockPerson(personId, { nextFollowUpAt: date });
}

export async function logMockTouchpoint(
  personId: string,
  touchType: ContactTouchpointType,
  occurredAt?: string,
): Promise<PeopleMaintenanceResult> {
  return updateMockPerson(personId, {
    lastContactAt: occurredAt ?? todayISO(),
    lastTouchpointType: touchType,
  });
}

function applyPatch(person: Person, patch: PersonPatch) {
  if (patch.name !== undefined) person.name = patch.name;
  if (patch.segment !== undefined) person.segment = patch.segment;
  if (patch.organization !== undefined) person.organization = patch.organization;
  if (patch.roleTitle !== undefined) person.roleTitle = patch.roleTitle;
  if (patch.sourceContext !== undefined) {
    person.sourceContext = patch.sourceContext;
    person.since = patch.sourceContext ?? person.since;
    person.identityTags = patch.sourceContext ? [patch.sourceContext] : person.identityTags;
  }
  if (patch.starred !== undefined) person.starred = patch.starred;
  if (patch.knownFacts !== undefined) person.knownFacts = patch.knownFacts;
  if (patch.lastContactAt !== undefined) {
    if (patch.lastContactAt) person.lastContactAt = patch.lastContactAt;
    else delete person.lastContactAt;
  }
  if (patch.lastTouchpointType !== undefined) {
    if (patch.lastTouchpointType) person.lastTouchpointType = patch.lastTouchpointType;
    else delete person.lastTouchpointType;
  }
  if (patch.nextFollowUpAt !== undefined) {
    if (patch.nextFollowUpAt) person.nextFollowUpAt = patch.nextFollowUpAt;
    else delete person.nextFollowUpAt;
  }
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function notFound(): PeopleMaintenanceResult {
  return {
    ok: false,
    status: 404,
    code: "not_found",
    error: "Person not found.",
  };
}
