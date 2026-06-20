import { NextResponse } from "next/server";
import { handleMockInboundCommand } from "@/lib/server/channels/mock-inbound.server";

export const dynamic = "force-dynamic";

// POST /api/channels/mock/inbound
//
// DB-backed local provider-adapter shape for command channels. Unlike
// `/api/channels/mock`, this route resolves provider identity through
// `channel_accounts` before calling the shared command router. It still
// never creates drafts, enqueues deliveries, or sends messages.

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: "invalid_request", detail: "body must be JSON" },
      { status: 400 },
    );
  }

  const result = await handleMockInboundCommand(body);
  return NextResponse.json(result.body, { status: result.status });
}
