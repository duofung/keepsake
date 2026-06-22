import "server-only";

import type { PersonCreateInput } from "@/lib/repositories";
import {
  AuthError,
  currentUserIdOrThrow,
} from "@/lib/server/auth/current-user.server";
import { transaction } from "@/lib/server/db/transaction.server";
import { createPeopleRepository } from "@/lib/repositories/people.server";
import type { PeopleCreateResult } from "./index.server";

const peopleRepository = createPeopleRepository();

export async function createDbPerson(input: PersonCreateInput): Promise<PeopleCreateResult> {
  try {
    const ownerId = await currentUserIdOrThrow();
    const person = await transaction(ownerId, (tx) => (
      peopleRepository.create(ownerId, input, tx)
    ));
    return { ok: true, person };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (pgCode(error) === "23503") {
      return {
        ok: false,
        status: 400,
        code: "invalid_reference",
        error: "Choose a valid relationship and culture.",
      };
    }

    console.error(error);
    return {
      ok: false,
      status: 500,
      code: "unavailable",
      error: "Could not create person.",
    };
  }
}

function pgCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
