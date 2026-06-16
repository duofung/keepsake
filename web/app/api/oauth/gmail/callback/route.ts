import { NextResponse } from "next/server";
import {
  AuthError,
  currentUserIdOrThrow,
} from "@/lib/server/auth/current-user.server";
import { completeGmailOAuth } from "@/lib/server/oauth/gmail.server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const ownerId = currentUserIdOrThrow();
    const result = await completeGmailOAuth({
      ownerId,
      code: url.searchParams.get("code")?.trim() || null,
      state: url.searchParams.get("state")?.trim() || null,
      providerError: url.searchParams.get("error")?.trim() || null,
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
