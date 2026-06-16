import "server-only";

import type { OwnerId } from "@/lib/repositories";

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_TEXT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
}

export function currentUserIdOrThrow(): OwnerId {
  return currentUserOrThrow().id;
}

export function currentUserOrThrow(): CurrentUser {
  const id = process.env.DEV_OWNER_ID?.trim() ?? "";
  const email = process.env.DEV_OWNER_EMAIL?.trim() ?? "";
  const name = process.env.DEV_OWNER_NAME?.trim() ?? "";

  if (!id) {
    throw new AuthError(
      "unauthenticated",
      "DEV_OWNER_ID is required until real auth is wired.",
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
