import "server-only";

// Google identity sign-in OAuth (P6-B).
//
// This is a DIFFERENT OAuth flow from `lib/server/oauth/gmail.server.ts`:
//
//   - That flow asks Google for `gmail.send` so Keepsake can send mail
//     ON BEHALF of the user.
//   - This flow asks Google for `openid email profile` so Keepsake can
//     prove who the user is. It does NOT touch `gmail_accounts`, does
//     NOT request a refresh token to keep, and does NOT influence
//     `CurrentUser.sendingAccount`.
//
// Result: a `keepsake_session` cookie minted from a `users` row that we
// find-or-create on the verified email. `/api/session` continues to
// return the same `{ user }` shape it always did.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createUsersRepository } from "@/lib/repositories/users.server";
import {
  workerTransaction,
} from "@/lib/server/db/transaction.server";
import { dataSource } from "./current-user.server";
import {
  type SessionCookie,
  hasValidSessionSecret,
  issueSessionCookie,
} from "./session.server";

export type GoogleSignInErrorCode =
  | "invalid_callback"
  | "not_configured"
  | "provider_error"
  | "service_unavailable";

const IDENTITY_SCOPES = ["openid", "email", "profile"];
const OAUTH_STATE_COOKIE = "keepsake_auth_oauth_state";
const STATE_TTL_SECONDS = 10 * 60;
const RETURN_TO_DEFAULT = "/";
const RELATIVE_PATH = /^\/(?!\/)[^\s]*$/;
const DEFAULT_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SIGNING_SECRET_MIN_LENGTH = 32;

export interface GoogleSignInCookie {
  readonly name: string;
  readonly value: string;
  readonly options: {
    readonly httpOnly: true;
    readonly sameSite: "lax";
    readonly secure: boolean;
    readonly path: string;
    readonly maxAge: number;
  };
}

export interface GoogleSignInFailure {
  readonly ok: false;
  readonly status: 400 | 500 | 501;
  readonly code: GoogleSignInErrorCode;
  readonly error: string;
  readonly setCookies?: readonly GoogleSignInCookie[];
}

export interface GoogleSignInRedirect {
  readonly ok: true;
  readonly redirectTo: string;
  readonly setCookies: readonly GoogleSignInCookie[];
}

export type GoogleSignInResult = GoogleSignInFailure | GoogleSignInRedirect;

export interface StartSignInInput {
  readonly returnTo: string | null;
  readonly origin: string;
}

export interface CompleteSignInInput {
  readonly code: string | null;
  readonly state: string | null;
  readonly providerError: string | null;
  readonly stateCookie: string | null;
  readonly origin: string;
}

interface StatePayload {
  returnTo: string;
  state: string;
  issuedAt: number;
}

interface GoogleSignInConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly signingSecret: Buffer;
  readonly authUrl: string;
  readonly tokenEndpoint: string;
  redirectUri(origin: string): string;
}

interface TokenResponse {
  idToken: string;
}

interface IdTokenClaims {
  email: string;
  displayName: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

export async function startGoogleSignIn(
  input: StartSignInInput,
): Promise<GoogleSignInResult> {
  const config = signInConfig();
  if (!config) return notConfigured();

  const redirectUri = config.redirectUri(input.origin);
  const returnTo = safeReturnTo(input.returnTo);
  const state = randomBytes(18).toString("base64url");
  const cookieValue = signStatePayload(config.signingSecret, {
    returnTo,
    state,
    issuedAt: Math.floor(Date.now() / 1000),
  });

  const authUrl = new URL(config.authUrl);
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", IDENTITY_SCOPES.join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "select_account");

  return {
    ok: true,
    redirectTo: authUrl.toString(),
    setCookies: [
      makeStateCookie(cookieValue, isSecureOrigin(redirectUri), STATE_TTL_SECONDS),
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Callback
// ─────────────────────────────────────────────────────────────────────────────

export async function completeGoogleSignIn(
  input: CompleteSignInInput,
): Promise<GoogleSignInResult> {
  const secure = isSecureOrigin(input.origin);

  if (input.providerError) {
    return invalidCallback(
      "provider_error",
      "Google sign-in was not authorized.",
      [clearStateCookieFor(secure)],
    );
  }

  if (!input.code || !input.state) {
    return invalidCallback(
      "invalid_callback",
      "Missing Google sign-in callback parameters.",
      [clearStateCookieFor(secure)],
    );
  }

  const config = signInConfig();
  if (!config) {
    if (input.stateCookie) {
      return { ...notConfigured(), setCookies: [clearStateCookieFor(secure)] };
    }
    return notConfigured();
  }

  if (!input.stateCookie) {
    return invalidCallback(
      "invalid_callback",
      "Missing Google sign-in state cookie.",
      [clearStateCookieFor(secure)],
    );
  }

  const payload = verifyStatePayload(config.signingSecret, input.stateCookie);
  if (!payload) {
    return invalidCallback(
      "invalid_callback",
      "Google sign-in state cookie is invalid.",
      [clearStateCookieFor(secure)],
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - payload.issuedAt > STATE_TTL_SECONDS) {
    return invalidCallback(
      "invalid_callback",
      "Google sign-in state has expired.",
      [clearStateCookieFor(secure)],
    );
  }

  if (payload.state !== input.state) {
    return invalidCallback(
      "invalid_callback",
      "Google sign-in state mismatch.",
      [clearStateCookieFor(secure)],
    );
  }

  // We need DB to persist the users row. Mock mode is the existing
  // DEV_OWNER fallback; sign-in is a no-op there.
  if (dataSource() !== "db") {
    return {
      ...notConfigured(),
      setCookies: [clearStateCookieFor(secure)],
    };
  }

  const redirectUri = config.redirectUri(input.origin);
  const tokens = await exchangeCode(config, input.code, redirectUri);
  if (!tokens) {
    return invalidCallback(
      "invalid_callback",
      "Google sign-in token exchange failed.",
      [clearStateCookieFor(secure)],
    );
  }

  const claims = claimsFromIdToken(tokens.idToken);
  if (!claims) {
    return invalidCallback(
      "invalid_callback",
      "Google sign-in id_token did not include a verifiable email.",
      [clearStateCookieFor(secure)],
    );
  }

  // Find-or-create the users row, then mint a session cookie. The
  // users repo runs under workerTransaction (no app.user_id) because
  // the sign-in path discovers identity before it knows it.
  //
  // Internal failures here are NOT user-facing callback errors. We
  // surface them as 500 `service_unavailable` so operators can tell a
  // genuine bad-callback (400 invalid_callback) from a server outage.
  let user;
  try {
    user = await workerTransaction(async (tx) => {
      const repo = createUsersRepository();
      const existing = await repo.findByEmail(claims.email, tx);
      if (existing) return existing;
      return repo.createFromGoogleProfile(
        { email: claims.email, displayName: claims.displayName },
        tx,
      );
    });
  } catch (error) {
    console.error(error);
    return serviceUnavailable(
      "Could not persist the sign-in user row.",
      [clearStateCookieFor(secure)],
    );
  }

  // Mint the session cookie with the schema-canonical ownerId + email.
  // Missing APP_SESSION_SIGNING_SECRET was already screened by
  // `signInConfig()` — if `issueSessionCookie` still throws here, it's
  // a genuine internal failure, not a user-facing callback problem.
  let session: SessionCookie;
  try {
    session = issueSessionCookie({
      ownerId: user.id,
      email: user.email,
      name: user.displayName ?? user.email,
      secure,
    });
  } catch (error) {
    console.error(error);
    return serviceUnavailable(
      "Could not mint a session cookie.",
      [clearStateCookieFor(secure)],
    );
  }

  return {
    ok: true,
    redirectTo: `${input.origin}${safeReturnTo(payload.returnTo)}`,
    setCookies: [session, clearStateCookieFor(secure)],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function invalidCallback(
  code: "invalid_callback" | "provider_error",
  error: string,
  setCookies: readonly GoogleSignInCookie[],
): GoogleSignInFailure {
  // 400-family failures: bad request from the user's browser, a
  // hostile / replayed callback, a missing state cookie, etc. These
  // are NOT internal failures.
  return { ok: false, status: 400, code, error, setCookies };
}

function serviceUnavailable(
  error: string,
  setCookies: readonly GoogleSignInCookie[],
): GoogleSignInFailure {
  // 500: the request was well-formed but the server couldn't complete
  // the sign-in (DB unreachable, session-mint crypto failure, …). The
  // user can usually retry; operators need to investigate.
  return {
    ok: false,
    status: 500,
    code: "service_unavailable",
    error,
    setCookies,
  };
}

function signInConfig(): GoogleSignInConfig | null {
  const clientId = process.env.KEEPSAKE_AUTH_GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.KEEPSAKE_AUTH_GOOGLE_CLIENT_SECRET?.trim() ?? "";
  const redirectUri = process.env.KEEPSAKE_AUTH_GOOGLE_REDIRECT_URI?.trim() ?? "";
  const signingSecretRaw = process.env.OAUTH_STATE_SIGNING_SECRET?.trim() ?? "";
  const tokenEndpoint =
    process.env.KEEPSAKE_AUTH_GOOGLE_TOKEN_ENDPOINT?.trim() || DEFAULT_TOKEN_ENDPOINT;
  const authUrl =
    process.env.KEEPSAKE_AUTH_GOOGLE_AUTH_URL?.trim() || DEFAULT_AUTH_URL;

  if (!clientId || !clientSecret || !redirectUri) return null;
  if (signingSecretRaw.length < SIGNING_SECRET_MIN_LENGTH) return null;
  // Session-cookie minting is part of the same configuration surface —
  // if we can't issue a `keepsake_session` we shouldn't start a sign-in
  // flow. Failing early at start AND callback keeps the user-facing
  // outcome a deterministic `not_configured`, never an `invalid_callback`
  // that hits mid-flow.
  if (!hasValidSessionSecret()) return null;

  return {
    clientId,
    clientSecret,
    signingSecret: Buffer.from(signingSecretRaw, "utf8"),
    authUrl,
    tokenEndpoint,
    redirectUri(origin: string) {
      if (redirectUri === "__ORIGIN__/api/auth/google/callback") {
        return `${origin}/api/auth/google/callback`;
      }
      return redirectUri;
    },
  };
}

function isSecureOrigin(uri: string): boolean {
  return uri.startsWith("https://");
}

function safeReturnTo(input: string | null): string {
  const value = input?.trim() ?? "";
  return RELATIVE_PATH.test(value) ? value : RETURN_TO_DEFAULT;
}

function makeStateCookie(value: string, secure: boolean, maxAge: number): GoogleSignInCookie {
  return {
    name: OAUTH_STATE_COOKIE,
    value,
    options: {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge,
    },
  };
}

function clearStateCookieFor(secure: boolean): GoogleSignInCookie {
  return makeStateCookie("", secure, 0);
}

function signStatePayload(secret: Buffer, payload: StatePayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

function verifyStatePayload(secret: Buffer, raw: string): StatePayload | null {
  const dot = raw.lastIndexOf(".");
  if (dot <= 0 || dot >= raw.length - 1) return null;

  const encoded = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);

  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.returnTo !== "string"
    || typeof obj.state !== "string"
    || typeof obj.issuedAt !== "number"
  ) {
    return null;
  }
  return {
    returnTo: obj.returnTo,
    state: obj.state,
    issuedAt: obj.issuedAt,
  };
}

async function exchangeCode(
  config: GoogleSignInConfig,
  code: string,
  redirectUri: string,
): Promise<TokenResponse | null> {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  let res: Response;
  try {
    res = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const idToken = (json as Record<string, unknown>).id_token;
  if (typeof idToken !== "string" || idToken.length === 0) return null;
  return { idToken };
}

function claimsFromIdToken(idToken: string): IdTokenClaims | null {
  const segments = idToken.split(".");
  if (segments.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(segments[1], "base64url").toString("utf8"),
    );
    if (!payload || typeof payload !== "object") return null;
    const obj = payload as Record<string, unknown>;
    const email = obj.email;
    if (typeof email !== "string" || email.length === 0) return null;
    // Strict gate: an id_token without `email_verified === true` is
    // refused. Missing field / non-boolean / explicit false all fail.
    // Google sets this field on every standard sign-in id_token, so
    // missing means something is wrong with the upstream.
    if (obj.email_verified !== true) return null;
    const displayName = typeof obj.name === "string" && obj.name.length > 0
      ? obj.name
      : null;
    return { email, displayName };
  } catch {
    return null;
  }
}

function notConfigured(): GoogleSignInFailure {
  return {
    ok: false,
    status: 501,
    code: "not_configured",
    error: "Google sign-in is not configured yet.",
  };
}
