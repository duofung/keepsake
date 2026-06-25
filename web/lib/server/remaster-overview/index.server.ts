import "server-only";

import type { RemasterDashboardOverview } from "@/lib/remaster/read-model";
import { buildRemasterDashboardOverview } from "@/lib/remaster/read-model";
import type { Delivery, PeoplePayload } from "@/lib/domain";
import { getDeliveryHistory } from "@/lib/server/delivery-history/index.server";
import { getPeoplePayload } from "@/lib/server/people-payload/index.server";

export interface RemasterPeopleCompatibilityView {
  overview: RemasterDashboardOverview;
  legacyPayload: PeoplePayload;
}

export interface RemasterHistoryCompatibilityView {
  overview: RemasterDashboardOverview;
  deliveries: Delivery[];
}

// Same shape for now; the named alias keeps Workspace consumers explicit.
export type RemasterWorkspaceCompatibilityView = RemasterPeopleCompatibilityView;

export async function getRemasterDashboardOverview(): Promise<RemasterDashboardOverview> {
  const view = await getRemasterPeopleCompatibilityView();
  return view.overview;
}

export async function getRemasterPeopleCompatibilityView(): Promise<RemasterPeopleCompatibilityView> {
  const view = await loadRemasterCompatibilityView();
  return {
    overview: view.overview,
    legacyPayload: view.legacyPayload,
  };
}

export async function getRemasterWorkspaceCompatibilityView(): Promise<RemasterWorkspaceCompatibilityView> {
  return getRemasterPeopleCompatibilityView();
}

export async function getRemasterHistoryCompatibilityView(): Promise<RemasterHistoryCompatibilityView> {
  const view = await loadRemasterCompatibilityView();
  return {
    overview: view.overview,
    deliveries: view.deliveries,
  };
}

async function loadRemasterCompatibilityView(): Promise<{
  overview: RemasterDashboardOverview;
  legacyPayload: PeoplePayload;
  deliveries: Delivery[];
}> {
  const payload = await getPeoplePayload();
  const deliveries = await getDeliveryHistory();
  return {
    overview: buildRemasterDashboardOverview(payload, deliveries),
    legacyPayload: payload,
    deliveries,
  };
}
