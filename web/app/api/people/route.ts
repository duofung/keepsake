import { NextResponse } from "next/server";
import { getPeoplePayload } from "@/lib/server/people-payload/index.server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getPeoplePayload());
}
