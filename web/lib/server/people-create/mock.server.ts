import "server-only";

import type { Person } from "@/lib/domain";
import type { PersonCreateInput } from "@/lib/repositories";
import type { PeopleCreateResult } from "./index.server";

type PreviewPersonCreateInput = PersonCreateInput & {
  readonly previewId?: string;
};

export async function createMockPerson(input: PreviewPersonCreateInput): Promise<PeopleCreateResult> {
  const person: Person = {
    id: input.previewId ?? `local-${Date.now().toString(36)}`,
    name: input.name,
    starred: input.starred ?? false,
    avatarBg: input.avatarBg,
    avatarFg: input.avatarFg,
    relationshipId: input.relationshipId,
    cultureId: input.cultureId,
    since: input.since,
    identityTags: input.identityTags ?? [],
    knownFacts: input.knownFacts ?? [{ text: "New relationship to learn about.", isLead: true }],
    personalTaboos: input.personalTaboos ?? [],
    nextOccasionId: null,
    lastContactAt: input.lastContactAt,
  };

  return { ok: true, person };
}
