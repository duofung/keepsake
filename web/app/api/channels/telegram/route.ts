import { NextResponse } from "next/server";
import {
  handleTelegramInboundUpdate,
  telegramFailureResponse,
} from "@/lib/server/channels/telegram.server";

export const dynamic = "force-dynamic";

// POST /api/channels/telegram
//
// Telegram Bot API webhook adapter. The provider-specific work here is
// intentionally small: parse JSON, verify Telegram's webhook secret header,
// normalise the update in the server seam, and let the shared channel command
// path resolve owner identity. It never creates drafts, enqueues deliveries,
// or sends email.

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

  try {
    const result = await handleTelegramInboundUpdate(body, req.headers);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    const result = telegramFailureResponse(error);
    if (result) {
      return NextResponse.json(result.body, { status: result.status });
    }
    console.error("Telegram inbound command failed:", error);
    return NextResponse.json(
      { code: "telegram_send_failed", detail: "Telegram sendMessage failed." },
      { status: 502 },
    );
  }
}
