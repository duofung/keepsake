import "server-only";

// Process-local mock draft store.
//
// The mock path doesn't have a real database, but Workspace + send boundary
// now expect three things from `/api/drafts`:
//
//   1. `POST` returns a draft with an id you can later look up.
//   2. `PATCH` saves a new edited version and surfaces it as "latest".
//   3. `GET` (latest + versions) reflects whatever the user just saved
//      inside the same process.
//
// This file is the minimum that satisfies those expectations without a DB.
// State lives at module scope and is rebuilt every time the Node process
// restarts — that is intentional. Cross-request consistency only needs to
// hold for the current process; tests and local dev work with one process
// at a time.

import type { ID, MessageDraft } from "@/lib/domain";

interface Bucket {
  // Newest-first list of drafts saved for a `(personId, occasionId)` pair.
  // Both POST-generated and PATCH-edited drafts go in here.
  versions: MessageDraft[];
}

/**
 * Provenance carried alongside each mock-store entry so the PATCH path
 * can inherit the same fields the DB path inherits (userInstruction,
 * modelProvider, modelVersion) without leaking them onto `MessageDraft`.
 */
export interface MockDraftProvenance {
  userInstruction: string;
  modelProvider: string | null;
  modelVersion: string | null;
}

const byBucket = new Map<string, Bucket>();
const byId = new Map<ID, MessageDraft>();
const provenanceById = new Map<ID, MockDraftProvenance>();

function bucketKey(personId: ID, occasionId: ID | null): string {
  return `${personId}::${occasionId ?? "__none__"}`;
}

export function recordMockDraft(
  draft: MessageDraft,
  provenance: MockDraftProvenance,
): MessageDraft {
  byId.set(draft.id, draft);
  provenanceById.set(draft.id, provenance);
  const key = bucketKey(draft.personId, draft.occasionId);
  const bucket = byBucket.get(key) ?? { versions: [] };
  bucket.versions = [draft, ...bucket.versions.filter((d) => d.id !== draft.id)];
  byBucket.set(key, bucket);
  return draft;
}

export function getMockDraftById(draftId: ID): MessageDraft | null {
  return byId.get(draftId) ?? null;
}

export function getMockProvenanceById(draftId: ID): MockDraftProvenance | null {
  return provenanceById.get(draftId) ?? null;
}

export function getMockLatest(
  personId: ID,
  occasionId: ID | null,
): MessageDraft | null {
  return byBucket.get(bucketKey(personId, occasionId))?.versions[0] ?? null;
}

export function listMockVersions(
  personId: ID,
  occasionId: ID | null,
  limit: number,
): MessageDraft[] {
  const versions = byBucket.get(bucketKey(personId, occasionId))?.versions ?? [];
  return versions.slice(0, Math.max(0, Math.trunc(limit)));
}

/**
 * Test hook — not used by route code. Lets harnesses reset between phases.
 */
export function __clearMockDraftStoreForTest(): void {
  byBucket.clear();
  byId.clear();
  provenanceById.clear();
}
