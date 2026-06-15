import "server-only";

import type { PeoplePayload } from "@/lib/domain";
import { getDbPeoplePayload } from "./db.server";
import { getMockPeoplePayload } from "./mock.server";

type PeopleDataSource = "mock" | "db";

function peopleDataSource(): PeopleDataSource {
  const source = process.env.KEEPSAKE_DATA_SOURCE ?? "mock";
  if (source === "mock" || source === "db") return source;

  throw new Error("KEEPSAKE_DATA_SOURCE must be either 'mock' or 'db'.");
}

export async function getPeoplePayload(): Promise<PeoplePayload> {
  return peopleDataSource() === "db"
    ? getDbPeoplePayload()
    : getMockPeoplePayload();
}
