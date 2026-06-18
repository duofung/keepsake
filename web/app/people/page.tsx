import { requireSessionUserOrRedirect } from "@/lib/server/auth/require-session.server";
import { getPeoplePayload } from "@/lib/server/people-payload/index.server";
import PeopleClient from "./PeopleClient";

export const dynamic = "force-dynamic";

export default async function PeoplePage() {
  await requireSessionUserOrRedirect("/people");
  const payload = await getPeoplePayload();
  return <PeopleClient payload={payload} />;
}
