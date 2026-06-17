import "server-only";

// Gmail send transport. Native `fetch` only — no Google SDK.
//
// Two steps every call goes through:
//   1. Refresh access token via OAuth (POST to `GOOGLE_TOKEN_ENDPOINT`).
//   2. Build a minimal plain-text MIME message + POST to
//      `KEEPSAKE_GMAIL_API_BASE + /gmail/v1/users/me/messages/send`.
//
// Both endpoints are env-overridable so tests can point at local stubs
// without touching Google's network. Failures normalise into
// `GmailTransportError` with one of the worker's `WorkerFailureReason`
// values so the orchestrator can map straight to `status: "failed"`.

import type { WorkerFailureReason } from "./types";

export class GmailTransportError extends Error {
  readonly reason: WorkerFailureReason;
  constructor(reason: WorkerFailureReason, message: string) {
    super(message);
    this.name = "GmailTransportError";
    this.reason = reason;
  }
}

/**
 * Raised by `assertGmailTransportConfig()` when the worker's global Gmail
 * env is missing. Deliberately distinct from `GmailTransportError`: a
 * misconfigured worker is a deployment problem, NOT a per-delivery
 * failure, and the orchestrator must keep its hands off the queued row.
 */
export class WorkerMisconfiguredError extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[]) {
    super(
      `Delivery worker is misconfigured. Missing env: ${missing.join(", ")}.`,
    );
    this.name = "WorkerMisconfiguredError";
    this.missing = missing;
  }
}

const DEFAULT_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DEFAULT_GMAIL_API_BASE = "https://gmail.googleapis.com";
const SEND_TIMEOUT_MS = 20_000;

interface GmailConfig {
  clientId: string;
  clientSecret: string;
  tokenEndpoint: string;
  apiBase: string;
}

/**
 * Throws `WorkerMisconfiguredError` if the global Gmail send env is not
 * usable. Safe to call from the worker's pre-claim path: no DB I/O, no
 * network, no side effects. The orchestrator MUST call this before
 * claiming a queued row so a deployment-level misconfiguration cannot
 * burn user deliveries to `failed`.
 */
export function assertGmailTransportConfig(): void {
  readConfig();
}

function readConfig(): GmailConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  const missing: string[] = [];
  if (!clientId) missing.push("GOOGLE_CLIENT_ID");
  if (!clientSecret) missing.push("GOOGLE_CLIENT_SECRET");
  if (missing.length) {
    throw new WorkerMisconfiguredError(missing);
  }
  return {
    clientId,
    clientSecret,
    tokenEndpoint: process.env.GOOGLE_TOKEN_ENDPOINT?.trim() || DEFAULT_TOKEN_ENDPOINT,
    apiBase: (process.env.KEEPSAKE_GMAIL_API_BASE?.trim() || DEFAULT_GMAIL_API_BASE)
      .replace(/\/+$/, ""),
  };
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function exchangeRefreshToken(
  cfg: GmailConfig,
  refreshToken: string,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  let res: Response;
  try {
    res = await fetchWithTimeout(cfg.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (error) {
    throw new GmailTransportError(
      "transport_error",
      `Token exchange network error: ${(error as Error)?.message ?? "unknown"}`,
    );
  }

  let parsed: TokenResponse;
  try {
    parsed = (await res.json()) as TokenResponse;
  } catch {
    throw new GmailTransportError(
      "transport_error",
      `Token endpoint returned non-JSON (status ${res.status}).`,
    );
  }

  if (!res.ok) {
    // invalid_grant means the refresh token is gone (revoked, expired, or
    // never valid). That's a `token_invalid` — orchestrator may also mark
    // the Gmail account expired before failing the delivery.
    if (parsed.error === "invalid_grant") {
      throw new GmailTransportError(
        "token_invalid",
        parsed.error_description ?? "invalid_grant",
      );
    }
    throw new GmailTransportError(
      "transport_error",
      `Token exchange failed (status ${res.status} ${parsed.error ?? "unknown"}).`,
    );
  }

  if (typeof parsed.access_token !== "string" || !parsed.access_token) {
    throw new GmailTransportError(
      "transport_error",
      "Token endpoint did not return an access_token.",
    );
  }
  return parsed.access_token;
}

export interface PlainTextEmail {
  fromEmail: string;
  toEmail: string;
  subject: string;
  paragraphs: { text: string }[];
  /** Stable Message-ID seed (delivery id) so retries land on the same MIME id. */
  messageIdSeed: string;
  /** Defaults to `now()`; injectable for deterministic tests. */
  date?: Date;
}

function encodeSubject(subject: string): string {
  // RFC 2047 encoded-word only when needed. Stays ASCII for the common case.
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function rfc2822Date(d: Date): string {
  // The Date.toUTCString() format is already RFC 1123 / RFC 2822 compliant
  // ("GMT" timezone). Gmail accepts it.
  return d.toUTCString();
}

function base64Url(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function buildPlainTextMime(input: PlainTextEmail): string {
  const date = input.date ?? new Date(0);
  const body = input.paragraphs
    .map((p) => p.text)
    .filter((t) => typeof t === "string" && t.length > 0)
    .join("\r\n\r\n");

  // Deterministic Message-ID seeded by delivery id so accidental re-sends
  // would, in theory, dedupe on the recipient side — Gmail doesn't enforce
  // this client-side, but the trace lives in the message.
  const messageId = `<delivery-${input.messageIdSeed}@keepsake.local>`;

  const headers = [
    `From: ${input.fromEmail}`,
    `To: ${input.toEmail}`,
    `Subject: ${encodeSubject(input.subject)}`,
    `Date: ${rfc2822Date(date)}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ];

  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

export interface GmailSendResult {
  /**
   * The canonical Gmail message id captured from the send response. A
   * 2xx response missing this field is treated as `transport_error` —
   * we refuse to mark the delivery `sent` without an id we can later
   * reconcile against webhooks / Google's API.
   */
  providerMessageId: string;
}

export interface GmailSendInput {
  refreshToken: string;
  email: PlainTextEmail;
}

interface GmailSendResponse {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  error?: { code?: number; message?: string };
}

/**
 * One-shot send. Caller is responsible for the surrounding worker
 * transaction (claim → send → mark). Never throws raw provider URLs; all
 * failures funnel through `GmailTransportError`.
 */
export async function sendGmailPlainText(
  input: GmailSendInput,
): Promise<GmailSendResult> {
  const cfg = readConfig();
  const accessToken = await exchangeRefreshToken(cfg, input.refreshToken);
  const mime = buildPlainTextMime(input.email);
  const raw = base64Url(Buffer.from(mime, "utf8"));

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${cfg.apiBase}/gmail/v1/users/me/messages/send`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ raw }),
      },
    );
  } catch (error) {
    throw new GmailTransportError(
      "transport_error",
      `Gmail send network error: ${(error as Error)?.message ?? "unknown"}`,
    );
  }

  let parsed: GmailSendResponse;
  try {
    parsed = (await res.json()) as GmailSendResponse;
  } catch {
    throw new GmailTransportError(
      "transport_error",
      `Gmail send returned non-JSON (status ${res.status}).`,
    );
  }

  if (!res.ok) {
    throw new GmailTransportError(
      "gmail_send_error",
      `Gmail send refused (status ${res.status} ${parsed.error?.message ?? "unknown"}).`,
    );
  }

  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new GmailTransportError(
      "transport_error",
      "Gmail send returned 2xx but no canonical message id.",
    );
  }

  return { providerMessageId: parsed.id };
}
