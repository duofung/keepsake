import { NextResponse } from "next/server";
import type { DeliveryRequest } from "@/lib/domain";
import {
  AuthError,
  currentUserIdOrThrow,
} from "@/lib/server/auth/current-user.server";
import { enqueueDelivery } from "@/lib/server/delivery-send/index.server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Parse JSON before authorising — same shape as `/api/drafts`.
  let body: DeliveryRequest;
  try {
    body = (await req.json()) as DeliveryRequest;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "invalid_request" },
      { status: 400 },
    );
  }

  let result;
  try {
    // Surface 401/500 before reaching the seam so the auth contract matches
    // `/api/session`. The DB dispatcher will resolve `currentUserIdOrThrow()`
    // again inside its own transaction — that is intentional and cheap.
    // The dispatcher itself calls `dataSource()`, which throws `AuthError`
    // when `KEEPSAKE_DATA_SOURCE` is invalid — same misconfigured contract
    // as `/api/session` and `/api/gmail/disconnect`.
    await currentUserIdOrThrow();
    result = await enqueueDelivery(body);
  } catch (error) {
    return authFailureResponse(error);
  }

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, code: result.code },
      { status: result.status },
    );
  }

  return NextResponse.json(result.queued, { status: 202 });
}

function authFailureResponse(error: unknown) {
  if (error instanceof AuthError) {
    const unauthenticated = error.kind === "unauthenticated";
    return NextResponse.json(
      { error: unauthenticated ? "Unauthenticated" : "Auth is misconfigured" },
      { status: unauthenticated ? 401 : 500 },
    );
  }
  return NextResponse.json({ error: "Auth failed" }, { status: 500 });
}
