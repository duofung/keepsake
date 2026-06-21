import { NextResponse } from "next/server";
import {
  AuthError,
  revokeChannelAccount,
} from "@/lib/server/channel-accounts/profile.server";

export const dynamic = "force-dynamic";

// POST /api/channels/telegram/revoke
//
// Owner-scoped revoke mutation for a manually linked Telegram identity.
// Same body contract as the mock revoke route; this provider-specific
// endpoint keeps the Profile form action honest even though both routes
// delegate to the same owner-scoped channel-account seam.

export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    const result = await revokeChannelAccount(body);
    if (result.ok) {
      return NextResponse.redirect(new URL("/profile#command-channels", req.url), 303);
    }
    return NextResponse.json(
      { code: result.code, detail: result.detail },
      { status: result.status },
    );
  } catch (error) {
    return mapAuthError(error);
  }
}

async function readBody(req: Request): Promise<{ accountId: unknown }> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      const json = await req.json();
      if (json && typeof json === "object") {
        return { accountId: (json as Record<string, unknown>).accountId };
      }
    } catch {
      // fall through
    }
    return { accountId: undefined };
  }
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const form = await req.formData();
    return { accountId: form.get("accountId") };
  }
  return { accountId: undefined };
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
