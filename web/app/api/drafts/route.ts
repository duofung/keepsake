import { NextResponse } from "next/server";
import type { DraftRequest } from "@/lib/domain";
import {
  generateDraft,
  getLatestDraft,
  saveDraftEdit,
  type DraftEditInput,
} from "@/lib/server/draft-service/index.server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const personId = url.searchParams.get("personId")?.trim() ?? "";
  const occasionId = url.searchParams.get("occasionId")?.trim() || null;

  const result = await getLatestDraft({ personId, occasionId });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return result.draft
    ? NextResponse.json(result.draft)
    : new Response(null, { status: 204 });
}

export async function POST(req: Request) {
  // 1. Parse JSON.
  let body: DraftRequest;
  try {
    body = (await req.json()) as DraftRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // 2. Generate via the server composition seam.
  const result = await generateDraft(body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  // 3. Respond.
  return NextResponse.json(result.draft);
}

export async function PATCH(req: Request) {
  // Save user-edited subject / attachedCard onto a base draft as a new
  // canonical version. The route stays thin: parse → delegate → JSON. All
  // ownership and validation live in `draft-service`.
  let body: DraftEditInput;
  try {
    body = (await req.json()) as DraftEditInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = await saveDraftEdit(body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(result.draft);
}
