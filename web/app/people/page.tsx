import { requireSessionUserOrRedirect } from "@/lib/server/auth/require-session.server";
import { getRemasterPeopleCompatibilityView } from "@/lib/server/remaster-overview/index.server";
import PeopleClient from "./PeopleClient";

export const dynamic = "force-dynamic";

export default async function PeoplePage() {
  await requireSessionUserOrRedirect("/people");
  const view = await getRemasterPeopleCompatibilityView();
  return <PeopleClient overview={view.overview} payload={view.legacyPayload} />;
}
