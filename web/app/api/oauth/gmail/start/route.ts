import { NextResponse } from "next/server";
import {
  AuthError,
  currentUserIdOrThrow,
} from "@/lib/server/auth/current-user.server";
import { startGmailOAuth } from "@/lib/server/oauth/gmail.server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const ownerId = currentUserIdOrThrow();
    const result = await startGmailOAuth({
      ownerId,
      returnTo: url.searchParams.get("returnTo")?.trim() || null,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: result.status },
      );
    }

    return NextResponse.redirect(result.redirectTo);
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
