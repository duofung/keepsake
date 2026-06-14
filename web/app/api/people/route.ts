import { NextResponse } from "next/server";
import { peoplePayload } from "@/lib/mock";

export const dynamic = "force-static";

export async function GET() {
  return NextResponse.json(peoplePayload());
}
