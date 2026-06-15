import "server-only";

// Server-only seam over the in-memory delivery history.
//
// Mock fallback: returns the Delivery[] used by the History page when
// KEEPSAKE_DATA_SOURCE is unset/mock. DB mode is dispatched from
// delivery-history/index.server.ts.

import type { Delivery } from "@/lib/domain";
import { deliveries } from "@/lib/mock";

export async function getMockDeliveryHistory(): Promise<Delivery[]> {
  return deliveries;
}
