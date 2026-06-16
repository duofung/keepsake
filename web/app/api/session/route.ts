import { NextResponse } from "next/server";
import {
  AuthError,
  currentUserOrThrow,
} from "@/lib/server/auth/current-user.server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ user: currentUserOrThrow() });
  } catch (error) {
    if (error instanceof AuthError) {
      const unauthenticated = error.kind === "unauthenticated";

      return NextResponse.json(
        { error: unauthenticated ? "Unauthenticated" : "Auth is misconfigured" },
        { status: unauthenticated ? 401 : 500 },
      );
    }

    return NextResponse.json({ error: "Auth failed" }, { status: 500 });
  }
}
