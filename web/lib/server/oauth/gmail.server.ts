import "server-only";

import type { OwnerId } from "@/lib/repositories";

export type GmailOAuthErrorCode =
  | "invalid_callback"
  | "not_configured"
  | "provider_error";

export interface GmailOAuthFailure {
  readonly ok: false;
  readonly status: 400 | 501;
  readonly code: GmailOAuthErrorCode;
  readonly error: string;
}

export interface GmailOAuthRedirect {
  readonly ok: true;
  readonly redirectTo: string;
}

export type GmailOAuthResult = GmailOAuthFailure | GmailOAuthRedirect;

export interface StartGmailOAuthInput {
  readonly ownerId: OwnerId;
  readonly returnTo: string | null;
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
  void input;

  return oauthNotConfigured();
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

function oauthNotConfigured(): GmailOAuthFailure {
  return {
    ok: false,
    status: 501,
    code: "not_configured",
    error: "Gmail OAuth is not configured yet.",
  };
}
