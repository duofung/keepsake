import "server-only";

import type { DeliveryRequest } from "@/lib/domain";
import { dataSource } from "@/lib/server/auth/current-user.server";
import { enqueueDbDelivery } from "./db.server";
import { enqueueMockDelivery } from "./mock.server";
import type { SendBoundaryResult } from "./types";

export type { DeliveryRequest, SendBoundaryResult };

export async function enqueueDelivery(
  input: DeliveryRequest,
): Promise<SendBoundaryResult> {
  return dataSource() === "db"
    ? enqueueDbDelivery(input)
    : enqueueMockDelivery(input);
}
