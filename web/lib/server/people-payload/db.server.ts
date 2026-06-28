import "server-only";

import type { PeoplePayload } from "@/lib/domain";
import { currentUserIdOrThrow } from "@/lib/server/auth/current-user.server";
import { transaction } from "@/lib/server/db/transaction.server";
import { createPeopleRepository } from "@/lib/repositories/people.server";
import type { PeoplePayloadOptions } from "./index.server";

const peopleRepository = createPeopleRepository();

export async function getDbPeoplePayload(options: PeoplePayloadOptions = {}): Promise<PeoplePayload> {
  const ownerId = await currentUserIdOrThrow();
  return transaction(ownerId, (tx) => (
    peopleRepository.listWithRelations(ownerId, tx, { scope: options.view ?? "active" })
  ));
}
