import { Suspense } from "react";
import { currentUserOrThrow } from "@/lib/server/auth/current-user.server";
import { getPeoplePayload } from "@/lib/server/people-payload/index.server";
import WorkspaceClient from "./WorkspaceClient";

export const dynamic = "force-dynamic";

export default async function Page() {
  const [currentUser, initialPayload] = await Promise.all([
    currentUserOrThrow(),
    getPeoplePayload(),
  ]);

  return (
    <Suspense fallback={null}>
      <WorkspaceClient currentUser={currentUser} initialPayload={initialPayload} />
    </Suspense>
  );
}
