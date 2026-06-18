import { NextResponse } from "next/server";
import {
  clearSessionCookie,
  isDevSessionRoutesEnabled,
} from "@/lib/server/auth/session.server";

export const dynamic = "force-dynamic";

// POST /api/auth/dev-session/clear
//
// Clears the `keepsake_session` cookie. Gated behind
// `ENABLE_DEV_SESSION_ROUTES=1`. Returns 404 when disabled (no
// information leak about why).

export async function POST(req: Request) {
  if (!isDevSessionRoutesEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const cookie = clearSessionCookie(isSecureOrigin(req));
  const response = NextResponse.json({ cleared: true }, { status: 200 });
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}

function isSecureOrigin(req: Request): boolean {
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}
