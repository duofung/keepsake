import "server-only";

import { createHash, randomBytes } from "node:crypto";
import type { OwnerId } from "@/lib/repositories";

export type GmailOAuthErrorCode =
  | "invalid_callback"
  | "not_configured"
  | "provider_error";

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const OAUTH_STATE_COOKIE = "keepsake_gmail_oauth_state";
const STATE_TTL_SECONDS = 10 * 60;
const RETURN_TO_DEFAULT = "/profile";
const RELATIVE_PATH = /^\/(?!\/)[^\s]*$/;

export interface GmailOAuthFailure {
  readonly ok: false;
  readonly status: 400 | 501;
  readonly code: GmailOAuthErrorCode;
  readonly error: string;
}

export interface GmailOAuthRedirect {
  readonly ok: true;
  readonly redirectTo: string;
  readonly setCookie: GmailOAuthCookie;
}

export type GmailOAuthResult = GmailOAuthFailure | GmailOAuthRedirect;

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
}

export async function startGmailOAuth(
  input: StartGmailOAuthInput,
): Promise<GmailOAuthResult> {
  const config = oauthConfig();
  if (!config) return oauthNotConfigured();

  const redirectUri = config.redirectUri(input.origin);
  const returnTo = safeReturnTo(input.returnTo);
  const state = randomBytes(18).toString("base64url");
  const cookiePayload = encodeStateCookie({
    ownerId: input.ownerId,
    returnTo,
    state,
  });
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("scope", GMAIL_SEND_SCOPE);
  authUrl.searchParams.set("state", state);

  return {
    ok: true,
    redirectTo: authUrl.toString(),
    setCookie: {
      name: OAUTH_STATE_COOKIE,
      value: cookiePayload,
      options: {
        httpOnly: true,
        sameSite: "lax",
        secure: redirectUri.startsWith("https://"),
        path: "/",
        maxAge: STATE_TTL_SECONDS,
      },
    },
  };
}

export async function completeGmailOAuth(
  input: CompleteGmailOAuthInput,
): Promise<GmailOAuthResult> {
  if (input.providerError) {
    return {
      ok: false,
      status: 400,
      code: "provider_error",
      error: "Gmail OAuth was not authorized.",
    };
  }

  if (!input.code || !input.state) {
    return {
      ok: false,
      status: 400,
      code: "invalid_callback",
      error: "Missing Gmail OAuth callback parameters.",
    };
  }

  return oauthNotConfigured();
}

interface GmailOAuthConfig {
  readonly clientId: string;
  readonly redirectUri: (origin: string) => string;
}

function oauthConfig(): GmailOAuthConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim() ?? "";

  if (!clientId || !redirectUri) return null;

  return {
    clientId,
    redirectUri(origin: string) {
      if (redirectUri === "__ORIGIN__/api/oauth/gmail/callback") {
        return `${origin}/api/oauth/gmail/callback`;
      }

      return redirectUri;
    },
  };
}

function safeReturnTo(input: string | null): string {
  const value = input?.trim() ?? "";
  return RELATIVE_PATH.test(value) ? value : RETURN_TO_DEFAULT;
}

function encodeStateCookie(input: {
  ownerId: OwnerId;
  returnTo: string;
  state: string;
}): string {
  const payload = Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
  const checksum = createHash("sha256")
    .update(payload)
    .digest("base64url")
    .slice(0, 20);

  return `${payload}.${checksum}`;
}

function oauthNotConfigured(): GmailOAuthFailure {
  return {
    ok: false,
    status: 501,
    code: "not_configured",
    error: "Gmail OAuth is not configured yet.",
  };
}
