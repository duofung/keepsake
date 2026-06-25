import { Suspense } from "react";
import { requireSessionUserOrRedirect } from "@/lib/server/auth/require-session.server";
import { getRemasterWorkspaceCompatibilityView } from "@/lib/server/remaster-overview/index.server";
import WorkspaceClient from "./WorkspaceClient";

export const dynamic = "force-dynamic";

interface WorkspacePageProps {
  readonly searchParams: Promise<{ readonly person?: string }>;
}

export default async function Page({ searchParams }: WorkspacePageProps) {
  const params = await searchParams;
  // Preserve the ?person= query in the post-sign-in return path so the
  // user lands back on the same compose view they were trying to open.
  const returnTo =
    typeof params.person === "string" && params.person.length > 0
      ? `/workspace?person=${encodeURIComponent(params.person)}`
      : "/workspace";

  // Sequential by design: auth guard must complete first so an
  // unauthenticated visitor in DB mode gets the /signin redirect, not a
  // 500 from the compatibility view racing its own currentUserIdOrThrow().
  const currentUser = await requireSessionUserOrRedirect(returnTo);
  const view = await getRemasterWorkspaceCompatibilityView();

  return (
    <Suspense fallback={null}>
      <WorkspaceClient
        currentUser={currentUser}
        initialPayload={view.legacyPayload}
        remasterOverview={view.overview}
      />
    </Suspense>
  );
}
