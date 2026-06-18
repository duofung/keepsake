import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  AuthError,
  currentUserIdOrThrow,
} from "@/lib/server/auth/current-user.server";
import { completeGmailOAuth } from "@/lib/server/oauth/gmail.server";

export const dynamic = "force-dynamic";

const STATE_COOKIE_NAME = "keepsake_gmail_oauth_state";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const ownerId = await currentUserIdOrThrow();
    const cookieStore = await cookies();
    const stateCookie = cookieStore.get(STATE_COOKIE_NAME)?.value ?? null;

    const result = await completeGmailOAuth({
      ownerId,
      code: url.searchParams.get("code")?.trim() || null,
      state: url.searchParams.get("state")?.trim() || null,
      providerError: url.searchParams.get("error")?.trim() || null,
      stateCookie,
      origin: url.origin,
    });

    const res = result.ok
      ? NextResponse.redirect(result.redirectTo)
      : NextResponse.json(
          { error: result.error, code: result.code },
          { status: result.status },
        );

    if (result.setCookie) {
      res.cookies.set(
        result.setCookie.name,
        result.setCookie.value,
        result.setCookie.options,
      );
    }

    return res;
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
