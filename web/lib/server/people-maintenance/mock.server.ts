import "server-only";

import type { Person } from "@/lib/domain";
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
  if (patch.nextFollowUpAt !== undefined) {
    if (patch.nextFollowUpAt) person.nextFollowUpAt = patch.nextFollowUpAt;
    else delete person.nextFollowUpAt;
  }
}

function notFound(): PeopleMaintenanceResult {
  return {
    ok: false,
    status: 404,
    code: "not_found",
    error: "Person not found.",
  };
}
