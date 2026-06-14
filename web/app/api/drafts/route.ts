import { NextResponse } from "next/server";
import type { DraftRequest } from "@/lib/domain";
import { findCulture, findOccasion, findPerson, findRelationship } from "@/lib/mock";
import { createMockDraftGenerator } from "@/lib/server/draft-generator/mock.server";
import type { DraftContext } from "@/lib/server/draft-generator/types";

export const dynamic = "force-dynamic";

// Stateless generator — instantiate once per process. When the LLM client
// lands it gets swapped here; the route body below does not move.
const draftGenerator = createMockDraftGenerator();

export async function POST(req: Request) {
  // 1. Parse JSON.
  let body: DraftRequest;
  try {
    body = (await req.json()) as DraftRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // 2. Validate required fields.
  const missing: string[] = [];
  if (!body?.personId) missing.push("personId");
  if (typeof body?.userInstruction !== "string") missing.push("userInstruction");
  if (missing.length) {
    return NextResponse.json(
      { error: `Missing fields: ${missing.join(", ")}` },
      { status: 400 },
    );
  }

  // 3. Hydrate person + catalog rows (server-authoritative: never trust the
  //    client to name a relationship or culture).
  const person = findPerson(body.personId);
  if (!person) {
    return NextResponse.json({ error: "Person not found" }, { status: 404 });
  }
  const relationship = findRelationship(person.relationshipId);
  const cultureRule = findCulture(person.cultureId);
  if (!relationship || !cultureRule) {
    return NextResponse.json(
      { error: "Person profile is incomplete" },
      { status: 500 },
    );
  }

  // 4. Resolve the occasion (falling back to the person's next one) and
  //    verify it actually belongs to this person.
  const requestedOccasionId = body.occasionId ?? person.nextOccasionId;
  const occasion = findOccasion(requestedOccasionId);
  if (requestedOccasionId && (!occasion || occasion.personId !== person.id)) {
    return NextResponse.json({ error: "Occasion not found" }, { status: 404 });
  }

  // 5. Delegate to the generator.
  const ctx: DraftContext = {
    person,
    relationship,
    cultureRule,
    occasion: occasion ?? null,
    userInstruction: body.userInstruction,
  };
  const draft = await draftGenerator.generate(ctx);

  return NextResponse.json(draft);
}
