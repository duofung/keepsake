import { NextResponse } from "next/server";
import { handleWhatsAppInboundUpdate } from "@/lib/server/channels/whatsapp.server";

export const dynamic = "force-dynamic";

// POST /api/channels/whatsapp
//
// WhatsApp inbound webhook foundation. This route verifies a shared webhook
// secret, parses JSON, and delegates provider normalisation + owner identity
// lookup to the server seam. It never creates drafts, enqueues deliveries, or
// sends through WhatsApp/Gmail.

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

  const result = await handleWhatsAppInboundUpdate(body, req.headers);
  return NextResponse.json(result.body, { status: result.status });
}
