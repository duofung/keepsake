import "server-only";

// Server-only resolver: takes a `DraftRequest` from the wire and produces a
// fully-hydrated `DraftContext` (or a structured error). The route handler
// stays free of mock-store knowledge.
//
// Today: backed by lib/mock.ts.
// Tomorrow: backed by PeopleRepository + CatalogRepository under RLS — same
// return shape, the route handler does not move. The future shape is in
// lib/repositories/README.md §"Future /api/drafts walkthrough".

import type { DraftRequest } from "@/lib/domain";
import { findCulture, findOccasion, findPerson, findRelationship } from "@/lib/mock";
import type { DraftContext } from "../draft-generator/types";

export type DraftContextResolution =
  | { ok: true; ctx: DraftContext }
  | { ok: false; status: 400 | 404 | 500; error: string };

export async function resolveDraftContext(
  input: DraftRequest,
): Promise<DraftContextResolution> {
  // 1. Required-field validation. The contract is intentionally narrow:
  //    only personId + userInstruction. Relationship and culture are
  //    server-authoritative — never accepted from the client.
  const missing: string[] = [];
  if (!input?.personId) missing.push("personId");
  if (typeof input?.userInstruction !== "string") missing.push("userInstruction");
  if (missing.length) {
    return { ok: false, status: 400, error: `Missing fields: ${missing.join(", ")}` };
  }

  // 2. Hydrate person.
  const person = findPerson(input.personId);
  if (!person) {
    return { ok: false, status: 404, error: "Person not found" };
  }

  // 3. Hydrate the catalog rows the person points at. Treat a missing FK
  //    as a 500 because it indicates broken data, not a bad request.
  const relationship = findRelationship(person.relationshipId);
  const cultureRule = findCulture(person.cultureId);
  if (!relationship || !cultureRule) {
    return { ok: false, status: 500, error: "Person profile is incomplete" };
  }

  // 4. Resolve the occasion. Prefer the client-supplied id, fall back to
  //    the person's `nextOccasionId`. Validate ownership: a client cannot
  //    name an occasion that belongs to a different person.
  const requestedOccasionId = input.occasionId ?? person.nextOccasionId;
  const occasion = findOccasion(requestedOccasionId);
  if (requestedOccasionId && (!occasion || occasion.personId !== person.id)) {
    return { ok: false, status: 404, error: "Occasion not found" };
  }

  return {
    ok: true,
    ctx: {
      person,
      relationship,
      cultureRule,
      occasion: occasion ?? null,
      userInstruction: input.userInstruction,
    },
  };
}
