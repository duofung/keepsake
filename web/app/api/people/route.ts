import { NextResponse } from "next/server";
import {
  AuthError,
  currentUserIdOrThrow,
} from "@/lib/server/auth/current-user.server";
import { createPersonFromRequest } from "@/lib/server/people-create/index.server";
import { getPeoplePayload } from "@/lib/server/people-payload/index.server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getPeoplePayload());
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "invalid_request" },
      { status: 400 },
    );
  }

  try {
    // Keep auth/misconfiguration mapping aligned with the other write routes.
    // The DB seam resolves the same user again inside its transaction.
    await currentUserIdOrThrow();
    const result = await createPersonFromRequest(body);

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: result.status },
      );
    }

    return NextResponse.json(result.person, { status: 201 });
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
