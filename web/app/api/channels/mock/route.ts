import { NextResponse } from "next/server";
import { routeCommandEvent } from "@/lib/server/channels/router.server";
import type { CommandEvent } from "@/lib/server/channels/types";

export const dynamic = "force-dynamic";

// POST /api/channels/mock
//
// Local-only mock for the command-channel transport. Real provider
// webhooks (WhatsApp / Telegram / Slack) will land at their own routes
// in later slices; each adapter normalises its payload into a
// `CommandEvent` and calls the same `routeCommandEvent()` seam.
//
// This route deliberately does NOT:
//   * authenticate the caller (channel identity is the
//     `externalUserId`, not a Keepsake session),
//   * touch the DB, queue, OpenAI, or any provider API,
//   * verify a webhook signature — there is no real provider here.
//
// Body shape:
//   {
//     provider?: "mock",        // defaults to "mock"
//     externalUserId?: string,  // any opaque id; defaults to null
//     externalThreadId?: string,
//     text: string,             // required, non-empty after trim
//   }

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

  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { code: "invalid_request", detail: "body must be an object" },
      { status: 400 },
    );
  }

  const raw = body as Record<string, unknown>;
  const text = typeof raw.text === "string" ? raw.text : "";
  if (text.trim().length === 0) {
    return NextResponse.json(
      { code: "invalid_request", detail: "text is required" },
      { status: 400 },
    );
  }

  const provider = raw.provider === undefined ? "mock" : raw.provider;
  if (provider !== "mock") {
    return NextResponse.json(
      {
        code: "invalid_request",
        detail: "this route only accepts provider=\"mock\"",
      },
      { status: 400 },
    );
  }

  const event: CommandEvent = {
    provider: "mock",
    externalUserId:
      typeof raw.externalUserId === "string" ? raw.externalUserId : null,
    externalThreadId:
      typeof raw.externalThreadId === "string" ? raw.externalThreadId : null,
    text,
    receivedAtISO: new Date().toISOString(),
    raw: body,
  };

  const response = await routeCommandEvent(event);
  return NextResponse.json(response, { status: 200 });
}
