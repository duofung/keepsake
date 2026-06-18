import { NextResponse } from "next/server";
import { ingestDeliveryWebhookEvent } from "@/lib/server/delivery-webhook/ingest.server";

export const dynamic = "force-dynamic";

const SECRET_HEADER = "x-keepsake-webhook-secret";
const SECRET_ENV = "DELIVERY_WEBHOOK_SECRET";

// POST /api/webhooks/deliveries
//
// Provider-agnostic delivery status webhook. Identity is the shared
// `DELIVERY_WEBHOOK_SECRET` header; there is no user session involved.
// The route stays thin — it gates the request, parses the JSON body,
// hands it to the ingest seam, and maps the result to HTTP. No SQL,
// no Gmail, no worker side effects.

export async function POST(req: Request) {
  const secret = process.env[SECRET_ENV];
  if (!secret || secret.length === 0) {
    return NextResponse.json(
      { error: "not_configured", code: "not_configured" },
      { status: 501 },
    );
  }
  const presented = req.headers.get(SECRET_HEADER);
  if (presented !== secret) {
    return NextResponse.json(
      { error: "unauthorized", code: "unauthorized" },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", code: "invalid_json" },
      { status: 400 },
    );
  }

  const result = await ingestDeliveryWebhookEvent(body as never);

  if (result.ok) {
    return NextResponse.json(
      {
        ok: true,
        deliveryId: result.deliveryId,
        status: result.deliveryStatus,
        updated: result.updated,
      },
      { status: result.status },
    );
  }

  return NextResponse.json(
    {
      ok: false,
      code: result.code,
      ...("detail" in result && result.detail ? { detail: result.detail } : {}),
    },
    { status: result.status },
  );
}
