import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { completeGoogleSignIn } from "@/lib/server/auth/google-signin.server";

export const dynamic = "force-dynamic";

const STATE_COOKIE_NAME = "keepsake_auth_oauth_state";

// GET /api/auth/google/callback
//
// Same thin shape as the start route. The service decides redirect
// destinations, state-cookie clearing, session-cookie minting, etc.
// This handler only translates HTTP → service-input and service-output
// → HTTP.

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");

  const cookieStore = await cookies();
  const stateCookie = cookieStore.get(STATE_COOKIE_NAME)?.value ?? null;

  const result = await completeGoogleSignIn({
    code,
    state,
    providerError,
    stateCookie,
    origin: url.origin,
  });

  if (result.ok) {
    const response = NextResponse.redirect(result.redirectTo, { status: 307 });
    for (const cookie of result.setCookies) {
      response.cookies.set(cookie.name, cookie.value, cookie.options);
    }
    return response;
  }

  const response = NextResponse.json(
    { error: result.error, code: result.code },
    { status: result.status },
  );
  if (result.setCookies) {
    for (const cookie of result.setCookies) {
      response.cookies.set(cookie.name, cookie.value, cookie.options);
    }
  }
  return response;
}
