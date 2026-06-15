import "server-only";

import type { OwnerId } from "@/lib/repositories";

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function currentUserIdOrThrow(): OwnerId {
  const id = process.env.DEV_OWNER_ID;

  if (!id) {
    throw new Error("DEV_OWNER_ID is required until real auth is wired.");
  }

  if (!UUID_TEXT.test(id)) {
    throw new Error("DEV_OWNER_ID must be a valid UUID.");
  }

  return id as OwnerId;
}
