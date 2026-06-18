import "server-only";

// App session cookie helper (P6-A foundation).
//
// Stateless signed cookie. No DB session table yet. Payload is the
// minimum identity the rest of the auth seam needs:
//
//   { ownerId, email, name, issuedAt, expiresAt }
//
// Signed with HMAC-SHA256 over `<base64url(JSON payload)>` and stored
// as `<base64url payload>.<base64url signature>`. The cookie name is
// `keepsake_session`. The signing secret is `APP_SESSION_SIGNING_SECRET`
// (≥32 chars).
//
// What this is NOT, yet:
//   - Not Google sign-in or any other identity provider integration.
//   - Not a multi-session manager.
//   - Not a DB session table.
//   - Not a refresh-token rotator.
// Those land later. For now this is the foundation everything else
// hangs off of.

import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "keepsake_session";
const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24h
const MIN_SECRET_LENGTH = 32;

/**
 * The dev-session bootstrap routes (`/api/auth/dev-session/*`) MUST NOT
 * be reachable in any environment that hasn't explicitly opted in. The
 * gate is a single env flag — production / staging leave it unset,
 * local dev + the smoke suite set `ENABLE_DEV_SESSION_ROUTES=1`. When
 * disabled, the routes return 404 (no information leak about why).
 */
export function isDevSessionRoutesEnabled(): boolean {
  return process.env.ENABLE_DEV_SESSION_ROUTES === "1";
}

export type SessionErrorKind = "unauthenticated" | "misconfigured";

export class SessionError extends Error {
  readonly kind: SessionErrorKind;
  constructor(kind: SessionErrorKind, message: string) {
    super(message);
    this.name = "SessionError";
    this.kind = kind;
  }
}

export interface SessionPayload {
  readonly ownerId: string;
  readonly email: string;
  readonly name: string;
  /** ms epoch */
  readonly issuedAt: number;
  /** ms epoch */
  readonly expiresAt: number;
}

export interface SessionCookie {
  readonly name: string;
  readonly value: string;
  readonly options: SessionCookieOptions;
}

export interface SessionCookieOptions {
  readonly httpOnly: true;
  readonly sameSite: "lax";
  readonly secure: boolean;
  readonly path: "/";
  readonly maxAge: number;
}

function base64url(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(text: string): Buffer {
  const padded = text
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function readSecret(): Buffer {
  const raw = process.env.APP_SESSION_SIGNING_SECRET?.trim() ?? "";
  if (raw.length < MIN_SECRET_LENGTH) {
    throw new SessionError(
      "misconfigured",
      `APP_SESSION_SIGNING_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`,
    );
  }
  return Buffer.from(raw, "utf8");
}

function sign(payloadB64: string, secret: Buffer): string {
  return base64url(createHmac("sha256", secret).update(payloadB64).digest());
}

export interface IssueSessionInput {
  readonly ownerId: string;
  readonly email: string;
  readonly name: string;
  /** Defaults to `Date.now()` — overridable for deterministic tests. */
  readonly nowMs?: number;
  /** Defaults to 24h. */
  readonly ttlSeconds?: number;
  /** Defaults to false (dev http). Sets `Secure` flag when true. */
  readonly secure?: boolean;
}

export function issueSessionCookie(input: IssueSessionInput): SessionCookie {
  const secret = readSecret();
  const now = input.nowMs ?? Date.now();
  const ttl = Math.max(60, Math.floor(input.ttlSeconds ?? DEFAULT_TTL_SECONDS));
  const payload: SessionPayload = {
    ownerId: input.ownerId,
    email: input.email,
    name: input.name,
    issuedAt: now,
    expiresAt: now + ttl * 1000,
  };
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = sign(payloadB64, secret);
  return {
    name: SESSION_COOKIE_NAME,
    value: `${payloadB64}.${sig}`,
    options: {
      httpOnly: true,
      sameSite: "lax",
      secure: input.secure ?? false,
      path: "/",
      maxAge: ttl,
    },
  };
}

export function clearSessionCookie(secure: boolean = false): SessionCookie {
  return {
    name: SESSION_COOKIE_NAME,
    value: "",
    options: {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: 0,
    },
  };
}

export interface VerifySessionInput {
  readonly cookieValue: string;
  /** Defaults to `Date.now()` — overridable for deterministic tests. */
  readonly nowMs?: number;
}

export function verifySessionCookie(
  input: VerifySessionInput,
): SessionPayload {
  const secret = readSecret();
  const raw = input.cookieValue;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new SessionError("unauthenticated", "Session cookie is empty.");
  }
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) {
    throw new SessionError("unauthenticated", "Session cookie is malformed.");
  }
  const payloadB64 = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = sign(payloadB64, secret);
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new SessionError("unauthenticated", "Session signature does not match.");
  }
  let payload: SessionPayload;
  try {
    payload = JSON.parse(fromBase64url(payloadB64).toString("utf8")) as SessionPayload;
  } catch {
    throw new SessionError("unauthenticated", "Session payload is not valid JSON.");
  }
  if (
    !payload
    || typeof payload.ownerId !== "string"
    || typeof payload.email !== "string"
    || typeof payload.name !== "string"
    || typeof payload.issuedAt !== "number"
    || typeof payload.expiresAt !== "number"
  ) {
    throw new SessionError("unauthenticated", "Session payload is missing fields.");
  }
  const now = input.nowMs ?? Date.now();
  if (now >= payload.expiresAt) {
    throw new SessionError("unauthenticated", "Session has expired.");
  }
  return payload;
}
