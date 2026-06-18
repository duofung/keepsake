import "server-only";

// Page-level "must be a session user" guard.
//
// Pages that count as "inside the product" call
// `requireSessionUserOrRedirect(currentPath)` from their server
// component. The contract is:
//
//   - If `currentSessionUserOrThrow()` succeeds → return the
//     `CurrentUser` and the page renders normally.
//   - If it throws `AuthError("unauthenticated", …)` → `redirect()`
//     to `/signin?returnTo=<currentPath>`. The redirect helper itself
//     throws, so the caller never continues past this line.
//   - If it throws `AuthError("misconfigured", …)` → re-raise.
//     A deployment-level break must NOT be silently masked as a
//     sign-in prompt — Next.js will surface a 500 instead.
//
// `currentUserOrThrow()` is deliberately unchanged: routes / API
// handlers / server seams still get the cookie-first, env-fallback
// behaviour. This helper is the boundary that says "from here on,
// product pages only accept real sessions".

import { redirect } from "next/navigation";
import {
  AuthError,
  type CurrentUser,
  currentSessionUserOrThrow,
} from "./current-user.server";

const RELATIVE_PATH = /^\/(?!\/)[^\s]*$/;

export async function requireSessionUserOrRedirect(
  returnTo: string | null = null,
): Promise<CurrentUser> {
  try {
    return await currentSessionUserOrThrow();
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.kind === "unauthenticated") {
        redirect(signinUrlFor(returnTo));
      }
      // `misconfigured` — let it propagate so Next surfaces a 500.
      throw error;
    }
    throw error;
  }
}

export function signinUrlFor(returnTo: string | null): string {
  const safe = safeReturnTo(returnTo);
  return safe && safe !== "/"
    ? `/signin?returnTo=${encodeURIComponent(safe)}`
    : "/signin";
}

export function safeReturnTo(
  input: string | null,
  fallback: string = "/",
): string {
  const value = input?.trim() ?? "";
  return RELATIVE_PATH.test(value) ? value : fallback;
}
