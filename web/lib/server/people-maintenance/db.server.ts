import "server-only";

import type { ContactTouchpointType } from "@/lib/domain";
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

export async function restoreDbPerson(personId: string): Promise<PeopleMaintenanceResult> {
  try {
    const ownerId = await currentUserIdOrThrow();
    const person = await transaction(ownerId, (tx) => (
      peopleRepository.restore(ownerId, personId, tx)
    ));
    return { ok: true, person };
  } catch (error) {
    return mapDbMaintenanceError(error, "Could not restore person.");
  }
}

export async function setDbNextFollowUp(personId: string, date: string): Promise<PeopleMaintenanceResult> {
  try {
    const ownerId = await currentUserIdOrThrow();
    const person = await transaction(ownerId, (tx) => (
      peopleRepository.setNextFollowUp(ownerId, personId, date, tx)
    ));
    return { ok: true, person };
  } catch (error) {
    return mapDbMaintenanceError(error, "Could not set next follow-up.");
  }
}

export async function markDbFollowUpDone(personId: string): Promise<PeopleMaintenanceResult> {
  try {
    const ownerId = await currentUserIdOrThrow();
    const person = await transaction(ownerId, (tx) => (
      peopleRepository.markFollowUpDone(ownerId, personId, tx)
    ));
    return { ok: true, person };
  } catch (error) {
    return mapDbMaintenanceError(error, "Could not mark follow-up done.");
  }
}

export async function snoozeDbFollowUp(personId: string, date: string): Promise<PeopleMaintenanceResult> {
  try {
    const ownerId = await currentUserIdOrThrow();
    const person = await transaction(ownerId, (tx) => (
      peopleRepository.snoozeFollowUp(ownerId, personId, date, tx)
    ));
    return { ok: true, person };
  } catch (error) {
    return mapDbMaintenanceError(error, "Could not snooze follow-up.");
  }
}

export async function logDbTouchpoint(
  personId: string,
  touchType: ContactTouchpointType,
  occurredAt?: string,
): Promise<PeopleMaintenanceResult> {
  try {
    const ownerId = await currentUserIdOrThrow();
    const person = await transaction(ownerId, (tx) => (
      peopleRepository.logTouchpoint(ownerId, personId, touchType, occurredAt, tx)
    ));
    return { ok: true, person };
  } catch (error) {
    return mapDbMaintenanceError(error, "Could not log touchpoint.");
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
  if (repoKind(error) === "validation") {
    return {
      ok: false,
      status: 400,
      code: "invalid_request",
      error: error instanceof Error ? error.message : "Invalid person state.",
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
