import { NextResponse } from "next/server";
import { getPeoplePayload } from "@/lib/server/people-payload/mock.server";

export const dynamic = "force-static";

export async function GET() {
  return NextResponse.json(await getPeoplePayload());
}
