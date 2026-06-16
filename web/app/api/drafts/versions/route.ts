import { NextResponse } from "next/server";
import { listDraftVersions } from "@/lib/server/draft-service/index.server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const personId = url.searchParams.get("personId")?.trim() ?? "";
  const occasionId = url.searchParams.get("occasionId")?.trim() || null;
  const limitParam = url.searchParams.get("limit")?.trim();
  const limit = limitParam ? Number(limitParam) : undefined;

  const result = await listDraftVersions({ personId, occasionId, limit });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ drafts: result.drafts });
}
