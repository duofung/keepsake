import "server-only";

import type { DraftRequest } from "@/lib/domain";
import { createCatalogRepository } from "@/lib/repositories/catalog.server";
import { createPeopleRepository } from "@/lib/repositories/people.server";
import { currentUserIdOrThrow } from "@/lib/server/auth/current-user.server";
import { transaction } from "@/lib/server/db/transaction.server";
import type { DraftContextResolution } from "./mock.server";

const catalogRepository = createCatalogRepository();
const peopleRepository = createPeopleRepository();

export async function resolveDbDraftContext(
  input: DraftRequest,
): Promise<DraftContextResolution> {
  const missing: string[] = [];
  if (!input?.personId) missing.push("personId");
  if (typeof input?.userInstruction !== "string") missing.push("userInstruction");
  if (missing.length) {
    return { ok: false, status: 400, error: `Missing fields: ${missing.join(", ")}` };
  }

  try {
    const ownerId = currentUserIdOrThrow();

    return await transaction(ownerId, async (tx) => {
      const person = await peopleRepository.findById(ownerId, input.personId, tx);
      if (!person) {
        return { ok: false, status: 404, error: "Person not found" };
      }

      const relationship = await catalogRepository.getRelationship(
        ownerId,
        person.relationshipId,
        tx,
      );
      if (!relationship) {
        return { ok: false, status: 500, error: "Person profile is incomplete" };
      }

      const cultureRule = await catalogRepository.getCulture(person.cultureId, tx);
      if (!cultureRule) {
        return { ok: false, status: 500, error: "Person profile is incomplete" };
      }

      if (input.occasionId) {
        const occasion = await peopleRepository.findOccasionForPerson(
          ownerId,
          person.id,
          input.occasionId,
          tx,
        );

        if (!occasion) {
          return { ok: false, status: 404, error: "Occasion not found" };
        }

        return {
          ok: true,
          ctx: {
            person,
            relationship,
            cultureRule,
            occasion,
            userInstruction: input.userInstruction,
          },
        };
      }

      const fallbackOccasion = person.nextOccasionId
        ? await peopleRepository.findOccasionForPerson(
          ownerId,
          person.id,
          person.nextOccasionId,
          tx,
        )
        : null;

      return {
        ok: true,
        ctx: {
          person,
          relationship,
          cultureRule,
          occasion: fallbackOccasion,
          userInstruction: input.userInstruction,
        },
      };
    });
  } catch (error) {
    console.error(error);
    return {
      ok: false,
      status: 500,
      error: "Draft context resolver is unavailable",
    };
  }
}
