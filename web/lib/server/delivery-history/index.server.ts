import "server-only";

import type { Delivery } from "@/lib/domain";
import { getDbDeliveryHistory } from "./db.server";
import { getMockDeliveryHistory } from "./mock.server";

type DeliveryHistoryDataSource = "mock" | "db";

function deliveryHistoryDataSource(): DeliveryHistoryDataSource {
  const source = process.env.KEEPSAKE_DATA_SOURCE ?? "mock";
  if (source === "mock" || source === "db") return source;

  throw new Error("KEEPSAKE_DATA_SOURCE must be either 'mock' or 'db'.");
}

export async function getDeliveryHistory(): Promise<Delivery[]> {
  return deliveryHistoryDataSource() === "db"
    ? getDbDeliveryHistory()
    : getMockDeliveryHistory();
}
