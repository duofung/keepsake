import "server-only";

// Server-only seam over the in-memory mock store.
//
// Today: returns the same PeoplePayload that lib/mock.ts produces, lifted
// behind a Promise so the call site already speaks the future async signature.
//
// Tomorrow: this becomes a one-line call into
// `PeopleRepository.listWithRelations(ownerId)` — and nothing in the route
// handler or the pages that consume `/api/people` has to change.
//
// Route handlers and other server modules should go through this helper
// instead of importing `lib/mock.ts` directly. Client components must not
// import it at all (Next.js enforces this via the "server-only" guard).

import { peoplePayload } from "@/lib/mock";
import type { PeoplePayload } from "@/lib/domain";

export async function getMockPeoplePayload(): Promise<PeoplePayload> {
  return peoplePayload();
}
