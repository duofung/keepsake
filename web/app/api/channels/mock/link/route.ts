import { NextResponse } from "next/server";
import {
  AuthError,
  linkMockChannelAccount,
} from "@/lib/server/channel-accounts/profile.server";

export const dynamic = "force-dynamic";

// POST /api/channels/mock/link
//
// Owner-scoped link mutation backing the Profile "Command channels"
// section (P8-F). Accepts JSON OR url-encoded / multipart form bodies
// so the same route serves curl-driven smokes and the server-rendered
// HTML form. Success → 303 redirect to /profile so the form
// submission flows POST-redirect-GET cleanly. Errors → JSON.

export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    const result = await linkMockChannelAccount(body);
    if (result.ok) {
      return NextResponse.redirect(new URL("/profile", req.url), 303);
    }
    return NextResponse.json(
      { code: result.code, detail: result.detail },
      { status: result.status },
    );
  } catch (error) {
    return mapAuthError(error);
  }
}

async function readBody(req: Request): Promise<{
  externalUserId: unknown;
  externalThreadId: unknown;
  displayName: unknown;
}> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      const json = await req.json();
      if (json && typeof json === "object") {
        const obj = json as Record<string, unknown>;
        return {
          externalUserId: obj.externalUserId,
          externalThreadId: obj.externalThreadId,
          displayName: obj.displayName,
        };
      }
    } catch {
      // fall through to empty body
    }
    return { externalUserId: undefined, externalThreadId: undefined, displayName: undefined };
  }
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const form = await req.formData();
    return {
      externalUserId: form.get("externalUserId"),
      externalThreadId: form.get("externalThreadId"),
      displayName: form.get("displayName"),
    };
  }
  return { externalUserId: undefined, externalThreadId: undefined, displayName: undefined };
}

function mapAuthError(error: unknown) {
  if (error instanceof AuthError) {
    const unauthenticated = error.kind === "unauthenticated";
    return NextResponse.json(
      { code: unauthenticated ? "unauthenticated" : "misconfigured" },
      { status: unauthenticated ? 401 : 500 },
    );
  }
  return NextResponse.json({ code: "server_error" }, { status: 500 });
}
