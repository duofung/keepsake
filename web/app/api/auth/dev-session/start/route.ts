import { NextResponse } from "next/server";
import {
  AuthError,
  devOwnerFromEnvOrThrow,
} from "@/lib/server/auth/current-user.server";
import {
  SessionError,
  isDevSessionRoutesEnabled,
  issueSessionCookie,
} from "@/lib/server/auth/session.server";

export const dynamic = "force-dynamic";

// POST /api/auth/dev-session/start
//
// Dev / test bootstrap. Gated behind `ENABLE_DEV_SESSION_ROUTES=1` —
// the route returns 404 in any environment that hasn't explicitly
// opted in.
//
// Bootstrap is env-ONLY by design (`devOwnerFromEnvOrThrow()`). The
// route deliberately does NOT consult any existing session cookie:
//
//   - a tampered cookie must not be able to block bootstrap (otherwise
//     a corrupt local state would be unrecoverable without `clear`),
//   - a stale but valid cookie must not silently override the
//     identity the operator just configured in `DEV_OWNER_*`.
//
// Successful response is the same `{ user }` shape as `/api/session`.

export async function POST(req: Request) {
  if (!isDevSessionRoutesEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let identity;
  try {
    identity = devOwnerFromEnvOrThrow();
  } catch (error) {
    return authFailureResponse(error);
  }

  let cookie;
  try {
    cookie = issueSessionCookie({
      ownerId: identity.id,
      email: identity.email,
      name: identity.name,
      secure: isSecureOrigin(req),
    });
  } catch (error) {
    if (error instanceof SessionError) {
      return NextResponse.json(
        { error: errorBodyForSession(error) },
        { status: error.kind === "unauthenticated" ? 401 : 500 },
      );
    }
    return NextResponse.json({ error: "Session issue failed" }, { status: 500 });
  }

  const response = NextResponse.json(
    { user: { ...identity, sendingAccount: null } },
    { status: 200 },
  );
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

function errorBodyForSession(error: SessionError): string {
  return error.kind === "misconfigured" ? "Auth is misconfigured" : "Unauthenticated";
}
