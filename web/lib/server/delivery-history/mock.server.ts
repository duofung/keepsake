import "server-only";

// Server-only seam over the in-memory delivery history.
//
// Today: returns the mock Delivery[] used by the History page.
//
// Tomorrow: this becomes `DeliveryRepository.listHistory(ownerId)` under RLS.
// The page should keep depending on this async helper rather than importing
// the mock store directly.

import type { Delivery } from "@/lib/domain";
import { deliveries } from "@/lib/mock";

export async function getDeliveryHistory(): Promise<Delivery[]> {
  return deliveries;
}
