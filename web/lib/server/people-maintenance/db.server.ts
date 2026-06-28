import "server-only";

import type { PersonPatch } from "@/lib/repositories";
import {
  AuthError,
  currentUserIdOrThrow,
} from "@/lib/server/auth/current-user.server";
import { createPeopleRepository } from "@/lib/repositories/people.server";
import { transaction } from "@/lib/server/db/transaction.server";
import type { PeopleMaintenanceResult } from "./index.server";

const peopleRepository = createPeopleRepository();

export async function updateDbPerson(
  personId: string,
  patch: PersonPatch,
): Promise<PeopleMaintenanceResult> {
  try {
    const ownerId = await currentUserIdOrThrow();
    const person = await transaction(ownerId, (tx) => (
      peopleRepository.update(ownerId, personId, patch, tx)
    ));
    return { ok: true, person };
  } catch (error) {
    return mapDbMaintenanceError(error, "Could not update person.");
  }
}

export async function archiveDbPerson(personId: string): Promise<PeopleMaintenanceResult> {
  try {
    const ownerId = await currentUserIdOrThrow();
    const person = await transaction(ownerId, (tx) => (
      peopleRepository.archive(ownerId, personId, tx)
    ));
    return { ok: true, person };
  } catch (error) {
    return mapDbMaintenanceError(error, "Could not archive person.");
  }
}

function mapDbMaintenanceError(error: unknown, fallback: string): PeopleMaintenanceResult {
  if (error instanceof AuthError) throw error;
  if (repoKind(error) === "not-found") {
    return {
      ok: false,
      status: 404,
      code: "not_found",
      error: "Person not found.",
    };
  }
  if (pgCode(error) === "23503" || pgCode(error) === "23514") {
    return {
      ok: false,
      status: 400,
      code: "invalid_request",
      error: "Unsupported person field value.",
    };
  }

  console.error(error);
  return {
    ok: false,
    status: 500,
    code: "unavailable",
    error: fallback,
  };
}

function repoKind(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("kind" in error)) return undefined;
  const kind = (error as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : undefined;
}

function pgCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
