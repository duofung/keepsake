import { NextResponse } from "next/server";
import {
  AuthError,
  revokeChannelAccount,
} from "@/lib/server/channel-accounts/profile.server";

export const dynamic = "force-dynamic";

// POST /api/channels/mock/revoke
//
// Owner-scoped revoke mutation backing the Profile "Command channels"
// section. Same shape as the link route: JSON or form body, 303 on
// success, JSON on error. Cross-owner / unknown ids surface as 404
// without leaking owner identity (the repo's `markRevoked` already
// throws "not found" under owner-scoped RLS).

export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    const result = await revokeChannelAccount(body);
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
