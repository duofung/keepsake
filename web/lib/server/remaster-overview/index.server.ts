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

// Same shape for now; the named alias keeps Workspace consumers explicit.
export type RemasterWorkspaceCompatibilityView = RemasterPeopleCompatibilityView;

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

export async function getRemasterWorkspaceCompatibilityView(): Promise<RemasterWorkspaceCompatibilityView> {
  return getRemasterPeopleCompatibilityView();
}
