import "server-only";

import type { RemasterDashboardOverview } from "@/lib/remaster/read-model";
import { buildRemasterDashboardOverview } from "@/lib/remaster/read-model";
import type { PeoplePayload } from "@/lib/domain";
import { getDeliveryHistory } from "@/lib/server/delivery-history/index.server";
import { getPeoplePayload } from "@/lib/server/people-payload/index.server";

export interface RemasterPeopleCompatibilityView {
  overview: RemasterDashboardOverview;
  legacyPayload: PeoplePayload;
}

export async function getRemasterDashboardOverview(): Promise<RemasterDashboardOverview> {
  const view = await getRemasterPeopleCompatibilityView();
  return view.overview;
}

export async function getRemasterPeopleCompatibilityView(): Promise<RemasterPeopleCompatibilityView> {
  const payload = await getPeoplePayload();
  const deliveries = await getDeliveryHistory();
  return {
    overview: buildRemasterDashboardOverview(payload, deliveries),
    legacyPayload: payload,
  };
}
