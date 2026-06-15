import { NextResponse } from "next/server";
import type { DraftRequest } from "@/lib/domain";
import { resolveDraftContext } from "@/lib/server/draft-context/index.server";
import { createMockDraftGenerator } from "@/lib/server/draft-generator/mock.server";

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

  // 2. Resolve context (validation + hydration + ownership checks).
  const result = await resolveDraftContext(body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  // 3. Generate + respond.
  const draft = await draftGenerator.generate(result.ctx);
  return NextResponse.json(draft);
}
