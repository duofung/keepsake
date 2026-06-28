import { NextResponse } from "next/server";
import {
  AuthError,
  currentUserIdOrThrow,
} from "@/lib/server/auth/current-user.server";
import { restorePersonFromRequest } from "@/lib/server/people-maintenance/index.server";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(_req: Request, context: RouteContext) {
  try {
    await currentUserIdOrThrow();
    const { id } = await context.params;
    const result = await restorePersonFromRequest(id);

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: result.status },
      );
    }

    return NextResponse.json({ person: result.person });
  } catch (error) {
    return authFailureResponse(error);
  }
}

function authFailureResponse(error: unknown) {
  if (error instanceof AuthError) {
    const unauthenticated = error.kind === "unauthenticated";
    return NextResponse.json(
      { error: unauthenticated ? "Unauthenticated" : "Auth is misconfigured" },
      { status: unauthenticated ? 401 : 500 },
    );
  }
  return NextResponse.json({ error: "Auth failed" }, { status: 500 });
}
