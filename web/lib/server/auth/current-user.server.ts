import "server-only";

// Current-user / owner resolver (P6-A cookie-backed foundation).
//
// Resolution order:
//   1. If a `keepsake_session` cookie is PRESENT, decode + verify it.
//      Any failure (signature, expiry, malformed payload) raises
//      `AuthError("unauthenticated")`. There is NO silent fallback
//      from a bad cookie to env — a bad cookie is an explicit auth
//      failure that operators / clients must repair.
//   2. If NO cookie is present, fall back to the `DEV_OWNER_*` env
//      identity. This is the transitional bridge that keeps local
//      dev + the existing smoke suite runnable while we layer real
//      sign-in on top.
//
// Public shape is unchanged: `CurrentUser` still has
// `{ id, email, name, initials, sendingAccount }`, `/api/session` still
// returns `{ user }`, the AuthError → 401/500 mapping at the route layer
// is the same. The only contract change is that
// `currentUserIdOrThrow()` is now async — every call site is already
// in an async chain, so the migration is a single `await`.

import { cookies } from "next/headers";
import type { OwnerId } from "@/lib/repositories";
import {
  SESSION_COOKIE_NAME,
  SessionError,
  verifySessionCookie,
} from "./session.server";

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_TEXT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATA_SOURCE_VALUES = new Set(["mock", "db"]);

export type AuthErrorKind = "unauthenticated" | "misconfigured";

export class AuthError extends Error {
  readonly kind: AuthErrorKind;

  constructor(kind: AuthErrorKind, message: string) {
    super(message);
    this.name = "AuthError";
    this.kind = kind;
  }
}

export interface CurrentUser {
  readonly id: OwnerId;
  readonly email: string;
  readonly name: string;
  readonly initials: string;
  readonly sendingAccount: SendingAccount | null;
}

export interface SendingAccount {
  readonly provider: "gmail";
  readonly email: string;
  readonly status: "connected" | "expired";
}

export async function currentUserIdOrThrow(): Promise<OwnerId> {
  const user = await currentUserBaseOrThrow();
  return user.id;
}

export async function currentUserOrThrow(): Promise<CurrentUser> {
  const user = await currentUserBaseOrThrow();
  return {
    ...user,
    sendingAccount: await sendingAccountFor(user.id),
  };
}

/**
 * Cookie-only resolver. NEVER falls back to `DEV_OWNER_*` env.
 * Pages that want to enforce "must have a real `keepsake_session`"
 * use this via `requireSessionUserOrRedirect()`; the rest of the
 * stack (routes, API handlers, server seams) keeps calling
 * `currentUserOrThrow()` and continues to allow env fallback.
 *
 * Errors:
 *   - missing cookie → `AuthError("unauthenticated", …)`
 *   - invalid / expired / tampered cookie → `AuthError("unauthenticated", …)`
 *   - missing `APP_SESSION_SIGNING_SECRET` when a cookie is present
 *     → `AuthError("misconfigured", …)` (inherited from the helper).
 */
export async function currentSessionUserOrThrow(): Promise<CurrentUser> {
  const fromCookie = await tryResolveFromCookie();
  if (!fromCookie) {
    throw new AuthError(
      "unauthenticated",
      "No session cookie present.",
    );
  }
  return {
    ...fromCookie,
    sendingAccount: await sendingAccountFor(fromCookie.id),
  };
}

async function currentUserBaseOrThrow(): Promise<Omit<CurrentUser, "sendingAccount">> {
  const fromCookie = await tryResolveFromCookie();
  if (fromCookie) return fromCookie;
  return resolveFromDevEnv();
}

/**
 * Returns the identity carried by a present, valid session cookie.
 *
 * - No cookie at all → `null` (caller falls through to env).
 * - Cookie present but invalid (bad signature, expired, malformed) →
 *   throws `AuthError("unauthenticated")`. We deliberately do NOT fall
 *   back to env in this case: a bad cookie is a signal the user / client
 *   needs to re-authenticate, not a free pass to silently downgrade.
 * - Missing / too-short signing secret → throws `AuthError("misconfigured")`.
 */
async function tryResolveFromCookie(): Promise<Omit<CurrentUser, "sendingAccount"> | null> {
  let cookieValue: string | undefined;
  try {
    const store = await cookies();
    cookieValue = store.get(SESSION_COOKIE_NAME)?.value;
  } catch {
    // `cookies()` throws when called from a non-request scope (some
    // edge-case server contexts). Treat that as "no cookie".
    return null;
  }
  if (!cookieValue) return null;

  let payload;
  try {
    payload = verifySessionCookie({ cookieValue });
  } catch (error) {
    if (error instanceof SessionError) {
      throw new AuthError(error.kind, error.message);
    }
    throw error;
  }

  if (!UUID_TEXT.test(payload.ownerId)) {
    throw new AuthError("unauthenticated", "Session ownerId is not a UUID.");
  }
  if (!EMAIL_TEXT.test(payload.email)) {
    throw new AuthError("unauthenticated", "Session email is malformed.");
  }
  if (!payload.name.trim()) {
    throw new AuthError("unauthenticated", "Session name is empty.");
  }
  return {
    id: payload.ownerId as OwnerId,
    email: payload.email,
    name: payload.name,
    initials: initialsFor(payload.name, payload.email),
  };
}

/**
 * Reads identity STRICTLY from `DEV_OWNER_*` env. No cookie consulted,
 * no fallback chain — call this from the dev-session bootstrap route
 * so a stale / tampered cookie can't deflect the identity we want to
 * mint a fresh session for. Validation errors map to the same
 * `AuthError` shape the rest of the seam uses.
 */
export function devOwnerFromEnvOrThrow(): Omit<CurrentUser, "sendingAccount"> {
  return resolveFromDevEnv();
}

function resolveFromDevEnv(): Omit<CurrentUser, "sendingAccount"> {
  const id = process.env.DEV_OWNER_ID?.trim() ?? "";
  const email = process.env.DEV_OWNER_EMAIL?.trim() ?? "";
  const name = process.env.DEV_OWNER_NAME?.trim() ?? "";

  if (!id) {
    throw new AuthError(
      "unauthenticated",
      "No session cookie and DEV_OWNER_ID is unset.",
    );
  }

  if (!UUID_TEXT.test(id)) {
    throw new AuthError("misconfigured", "DEV_OWNER_ID must be a valid UUID.");
  }

  if (!EMAIL_TEXT.test(email)) {
    throw new AuthError("misconfigured", "DEV_OWNER_EMAIL must be a valid email.");
  }

  if (!name) {
    throw new AuthError("misconfigured", "DEV_OWNER_NAME is required.");
  }

  return {
    id: id as OwnerId,
    email,
    name,
    initials: initialsFor(name, email),
  };
}

async function sendingAccountFor(ownerId: OwnerId): Promise<SendingAccount | null> {
  if (dataSource() !== "db") return null;

  const { createGmailAccountRepository } = await import(
    "@/lib/repositories/gmail-accounts.server"
  );
  const account = await createGmailAccountRepository().getPrimary(ownerId);

  if (!account) return null;

  return {
    provider: "gmail",
    email: account.email,
    status: account.status,
  };
}

/**
 * Strict data-source resolver. Other server seams that branch on
 * `KEEPSAKE_DATA_SOURCE` (currently `gmail-account/disconnect.server.ts`)
 * import this so they fail closed on a typo instead of silently downgrading
 * to mock and looking like a successful no-op.
 */
export function dataSource(): "mock" | "db" {
  const value = process.env.KEEPSAKE_DATA_SOURCE?.trim() || "mock";

  if (!DATA_SOURCE_VALUES.has(value)) {
    throw new AuthError(
      "misconfigured",
      `Unsupported KEEPSAKE_DATA_SOURCE "${value}".`,
    );
  }

  return value as "mock" | "db";
}

function initialsFor(name: string, email: string): string {
  const nameParts = words(name);
  const parts =
    nameParts.length > 0 ? nameParts : words(email.split("@")[0] ?? email);

  if (parts.length === 0) {
    return email.slice(0, 1).toUpperCase();
  }

  if (parts.length === 1) {
    return parts[0].slice(0, 1).toUpperCase();
  }

  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function words(value: string): string[] {
  return value.match(/[A-Za-z0-9]+/g) ?? [];
}
