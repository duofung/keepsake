import { getPeoplePayload } from "@/lib/server/people-payload/index.server";
import PeopleClient from "./PeopleClient";

export default async function PeoplePage() {
  const payload = await getPeoplePayload();
  return <PeopleClient payload={payload} />;
}
