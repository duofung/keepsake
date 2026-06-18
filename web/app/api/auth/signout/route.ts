import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/server/auth/session.server";
import { safeReturnTo } from "@/lib/server/auth/require-session.server";

export const dynamic = "force-dynamic";

// POST /api/auth/signout
//
// Tears down the app session cookie and bounces the caller to
// `/signin` (or, if a safe relative `returnTo` is provided, to
// that path). The route deliberately:
//
//   - does NOT read the current user — the cookie is already
//     untrusted at this point, and we don't want a tampered or
//     expired cookie to block sign-out,
//   - does NOT touch the DB,
//   - does NOT revoke the Google OAuth grant,
//   - does NOT disconnect the Gmail sending account (that lives at
//     `/api/gmail/disconnect`).
//
// The response is always 303 See Other so the browser follows
// with a GET — POST-redirect-GET, the usual form-submission shape.

export async function POST(req: Request) {
  const url = new URL(req.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"), "/signin");
  const cookie = clearSessionCookie(isSecureOrigin(req));
  const response = NextResponse.redirect(`${url.origin}${returnTo}`, {
    status: 303,
  });
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}

function isSecureOrigin(req: Request): boolean {
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}
