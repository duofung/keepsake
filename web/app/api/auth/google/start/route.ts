import { NextResponse } from "next/server";
import { startGoogleSignIn } from "@/lib/server/auth/google-signin.server";

export const dynamic = "force-dynamic";

// GET /api/auth/google/start
//
// Thin: parse `returnTo`, delegate to the sign-in service, apply the
// returned redirect + state cookie. The route never touches Google
// itself, never reads / writes tokens, and never decides on cookie
// attributes — those live in `google-signin.server.ts`.

export async function GET(req: Request) {
  const url = new URL(req.url);
  const returnTo = url.searchParams.get("returnTo");

  const result = await startGoogleSignIn({
    returnTo,
    origin: url.origin,
  });

  if (result.ok) {
    const response = NextResponse.redirect(result.redirectTo, { status: 307 });
    for (const cookie of result.setCookies) {
      response.cookies.set(cookie.name, cookie.value, cookie.options);
    }
    return response;
  }

  return jsonError(result);
}

function jsonError(result: {
  status: number;
  code: string;
  error: string;
  setCookies?: readonly { name: string; value: string; options: Record<string, unknown> }[];
}) {
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
