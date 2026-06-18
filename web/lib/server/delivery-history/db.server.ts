import "server-only";

import type { Delivery } from "@/lib/domain";
import { createDeliveryRepository } from "@/lib/repositories/deliveries.server";
import { currentUserIdOrThrow } from "@/lib/server/auth/current-user.server";
import { transaction } from "@/lib/server/db/transaction.server";

const deliveryRepository = createDeliveryRepository();

export async function getDbDeliveryHistory(): Promise<Delivery[]> {
  const ownerId = await currentUserIdOrThrow();
  return transaction(ownerId, (tx) => (
    deliveryRepository.listByMonth(ownerId, { limit: 50 }, tx)
  ));
}
