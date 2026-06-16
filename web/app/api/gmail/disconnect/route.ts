import { NextResponse } from "next/server";
import {
  AuthError,
  currentUserIdOrThrow,
} from "@/lib/server/auth/current-user.server";
import { disconnectGmailAccount } from "@/lib/server/gmail-account/disconnect.server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const ownerId = currentUserIdOrThrow();
    const result = await disconnectGmailAccount(ownerId, url.origin);
    return NextResponse.redirect(result.redirectTo, 303);
  } catch (error) {
    return authFailureResponse(error);
  }
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
