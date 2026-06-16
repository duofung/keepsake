import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { OwnerId } from "@/lib/repositories";
import { createGmailAccountRepository } from "@/lib/repositories/gmail-accounts.server";
import { transaction } from "@/lib/server/db/transaction.server";

export type GmailOAuthErrorCode =
  | "invalid_callback"
  | "not_configured"
  | "provider_error";

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
// `openid email` is the smallest officially-supported way to learn the
// authorizing user's verified email during the OAuth exchange. Without it the
// token response carries no account identity, and we would have no reliable
// value for `gmail_accounts.email`. We deliberately do NOT request `profile` or
// any other scope.
const IDENTITY_SCOPES = ["openid", "email"];
const OAUTH_STATE_COOKIE = "keepsake_gmail_oauth_state";
const STATE_TTL_SECONDS = 10 * 60;
const RETURN_TO_DEFAULT = "/profile";
const RELATIVE_PATH = /^\/(?!\/)[^\s]*$/;
const DEFAULT_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SIGNING_SECRET_MIN_LENGTH = 32;

export interface GmailOAuthCookie {
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

export interface GmailOAuthFailure {
  readonly ok: false;
  readonly status: 400 | 501;
  readonly code: GmailOAuthErrorCode;
  readonly error: string;
  readonly setCookie?: GmailOAuthCookie;
}

export interface GmailOAuthRedirect {
  readonly ok: true;
  readonly redirectTo: string;
  readonly setCookie: GmailOAuthCookie;
}

export type GmailOAuthResult = GmailOAuthFailure | GmailOAuthRedirect;

export interface StartGmailOAuthInput {
  readonly ownerId: OwnerId;
  readonly returnTo: string | null;
  readonly origin: string;
}

export interface CompleteGmailOAuthInput {
  readonly ownerId: OwnerId;
  readonly code: string | null;
  readonly state: string | null;
  readonly providerError: string | null;
  readonly stateCookie: string | null;
  readonly origin: string;
}

interface StatePayload {
  ownerId: string;
  returnTo: string;
  state: string;
  issuedAt: number;
}

interface GmailOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly signingSecret: Buffer;
  readonly tokenEndpoint: string;
  redirectUri(origin: string): string;
}

interface TokenResponse {
  refreshToken: string;
  idToken: string;
  expiresInSeconds: number | null;
  scope: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

export async function startGmailOAuth(
  input: StartGmailOAuthInput,
): Promise<GmailOAuthResult> {
  const config = oauthConfig();
  if (!config) return oauthNotConfigured();

  const redirectUri = config.redirectUri(input.origin);
  const returnTo = safeReturnTo(input.returnTo);
  const state = randomBytes(18).toString("base64url");
  const cookieValue = signStatePayload(config.signingSecret, {
    ownerId: String(input.ownerId),
    returnTo,
    state,
    issuedAt: Math.floor(Date.now() / 1000),
  });

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("scope", [...IDENTITY_SCOPES, GMAIL_SEND_SCOPE].join(" "));
  authUrl.searchParams.set("state", state);

  return {
    ok: true,
    redirectTo: authUrl.toString(),
    setCookie: makeStateCookie(
      cookieValue,
      isSecureOrigin(redirectUri),
      STATE_TTL_SECONDS,
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Callback
// ─────────────────────────────────────────────────────────────────────────────

export async function completeGmailOAuth(
  input: CompleteGmailOAuthInput,
): Promise<GmailOAuthResult> {
  const secure = isSecureOrigin(input.origin);

  if (input.providerError) {
    return invalidCallback(
      "provider_error",
      "Gmail OAuth was not authorized.",
      clearCookieFor(secure),
    );
  }

  if (!input.code || !input.state) {
    return invalidCallback(
      "invalid_callback",
      "Missing Gmail OAuth callback parameters.",
      clearCookieFor(secure),
    );
  }

  const config = oauthConfig();
  if (!config) {
    // Server is not configured. Don't echo a cookie instruction — if the
    // browser carries a stale state cookie from a previous configured run we
    // still want it cleared, but only if it had one.
    if (input.stateCookie) {
      return { ...oauthNotConfigured(), setCookie: clearCookieFor(secure) };
    }
    return oauthNotConfigured();
  }

  if (!input.stateCookie) {
    return invalidCallback(
      "invalid_callback",
      "Missing Gmail OAuth state cookie.",
      clearCookieFor(secure),
    );
  }

  const payload = verifyStatePayload(config.signingSecret, input.stateCookie);
  if (!payload) {
    return invalidCallback(
      "invalid_callback",
      "Gmail OAuth state cookie is invalid.",
      clearCookieFor(secure),
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - payload.issuedAt > STATE_TTL_SECONDS) {
    return invalidCallback(
      "invalid_callback",
      "Gmail OAuth state has expired.",
      clearCookieFor(secure),
    );
  }

  if (payload.ownerId !== String(input.ownerId)) {
    return invalidCallback(
      "invalid_callback",
      "Gmail OAuth state owner mismatch.",
      clearCookieFor(secure),
    );
  }

  if (payload.state !== input.state) {
    return invalidCallback(
      "invalid_callback",
      "Gmail OAuth state mismatch.",
      clearCookieFor(secure),
    );
  }

  const redirectUri = config.redirectUri(input.origin);
  const tokens = await exchangeCode(config, input.code, redirectUri);
  if (!tokens) {
    return invalidCallback(
      "invalid_callback",
      "Gmail OAuth token exchange failed.",
      clearCookieFor(secure),
    );
  }

  const email = emailFromIdToken(tokens.idToken);
  if (!email) {
    return invalidCallback(
      "invalid_callback",
      "Gmail OAuth response did not include an account email.",
      clearCookieFor(secure),
    );
  }

  const expiresAtISO = tokens.expiresInSeconds !== null
    ? new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString()
    : null;

  // Plaintext refresh token only crosses into the repository write boundary.
  // The repo encrypts before insert/update; nothing else touches the token.
  await transaction(input.ownerId, async (tx) =>
    createGmailAccountRepository().upsertPrimary(
      input.ownerId,
      {
        email,
        scopes: tokens.scope,
        refreshToken: tokens.refreshToken,
        refreshTokenExpiresAtISO: expiresAtISO,
      },
      tx,
    ),
  );

  const returnTo = safeReturnTo(payload.returnTo);

  return {
    ok: true,
    redirectTo: `${input.origin}${returnTo}`,
    setCookie: clearCookieFor(secure),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function invalidCallback(
  code: GmailOAuthErrorCode,
  error: string,
  setCookie: GmailOAuthCookie,
): GmailOAuthFailure {
  return { ok: false, status: 400, code, error, setCookie };
}

function oauthConfig(): GmailOAuthConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim() ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  const signingSecretRaw = process.env.OAUTH_STATE_SIGNING_SECRET?.trim() ?? "";
  const tokenEndpoint = process.env.GOOGLE_TOKEN_ENDPOINT?.trim() || DEFAULT_TOKEN_ENDPOINT;

  if (!clientId || !redirectUri || !clientSecret) return null;
  if (signingSecretRaw.length < SIGNING_SECRET_MIN_LENGTH) return null;

  const signingSecret = Buffer.from(signingSecretRaw, "utf8");

  return {
    clientId,
    clientSecret,
    signingSecret,
    tokenEndpoint,
    redirectUri(origin: string) {
      if (redirectUri === "__ORIGIN__/api/oauth/gmail/callback") {
        return `${origin}/api/oauth/gmail/callback`;
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

function makeStateCookie(value: string, secure: boolean, maxAge: number): GmailOAuthCookie {
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

function clearCookieFor(secure: boolean): GmailOAuthCookie {
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
  const sigBytes = Buffer.from(sig, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (sigBytes.length !== expectedBytes.length) return null;
  if (!timingSafeEqual(sigBytes, expectedBytes)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.ownerId !== "string" ||
    typeof obj.returnTo !== "string" ||
    typeof obj.state !== "string" ||
    typeof obj.issuedAt !== "number"
  ) {
    return null;
  }

  return {
    ownerId: obj.ownerId,
    returnTo: obj.returnTo,
    state: obj.state,
    issuedAt: obj.issuedAt,
  };
}

async function exchangeCode(
  config: GmailOAuthConfig,
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
  const obj = json as Record<string, unknown>;

  const refreshToken = typeof obj.refresh_token === "string" ? obj.refresh_token : null;
  const idToken = typeof obj.id_token === "string" ? obj.id_token : null;
  const expiresIn = typeof obj.expires_in === "number" ? obj.expires_in : null;
  const scopeStr = typeof obj.scope === "string" ? obj.scope : "";
  const scope = scopeStr ? scopeStr.split(" ").filter(Boolean) : [GMAIL_SEND_SCOPE];

  // We never need to keep the access_token — the worker will mint a fresh one
  // from refresh_token each send. refresh_token must be present (prompt=consent
  // guarantees it on Google's side); id_token must be present (we asked for
  // `openid email` and need it to learn the account email).
  if (!refreshToken || !idToken) return null;

  return { refreshToken, idToken, expiresInSeconds: expiresIn, scope };
}

function emailFromIdToken(idToken: string): string | null {
  const segments = idToken.split(".");
  if (segments.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(segments[1], "base64url").toString("utf8"),
    );
    if (!payload || typeof payload !== "object") return null;
    const email = (payload as Record<string, unknown>).email;
    return typeof email === "string" && email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

function oauthNotConfigured(): GmailOAuthFailure {
  return {
    ok: false,
    status: 501,
    code: "not_configured",
    error: "Gmail OAuth is not configured yet.",
  };
}
