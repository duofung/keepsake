import "server-only";

import type { OccasionNode, Person } from "@/lib/domain";
import type { OwnerId } from "@/lib/repositories";
import { createPeopleRepository } from "@/lib/repositories/people.server";
import { transaction } from "@/lib/server/db/transaction.server";
import { routeCommandEvent } from "./router.server";
import type {
  CommandEvent,
  CommandResponse,
} from "./types";

// Owner-scoped read path for command channels (P8-E).
//
// Once a provider webhook has resolved `(provider, externalUserId) → ownerId`
// via `ChannelAccountRepository.findByProviderUser`, it calls this seam so
// the channel reply can be specific to the user — naming the people who
// have something coming up — instead of the generic "open Keepsake to
// review" reply the keyword router emits.
//
// Hard limits (kept aligned with the brief):
//   - read-only on owner data,
//   - NEVER creates a draft, enqueues a delivery, calls Gmail,
//     touches `currentUser*`, or talks to a real provider,
//   - the channel still surfaces a `suggestedAction` deep link; the actual
//     send / review work happens inside Keepsake.
//
// The router's classifier stays the source of truth for intent. We only
// enrich the response text + intent payload AFTER intent is decided.

const peopleRepository = createPeopleRepository();
const FOLLOWUP_WINDOW_DAYS = 30;
const FOLLOWUP_TOP_N = 3;

export async function handleOwnerCommand(
  ownerId: OwnerId,
  event: CommandEvent,
): Promise<CommandResponse> {
  const base = await routeCommandEvent(event);

  if (base.intent !== "relationship_followup_query") {
    return base;
  }

  const upcoming = await transaction(ownerId, async (tx) => {
    const payload = await peopleRepository.listWithRelations(ownerId, tx);
    return selectFollowups(payload.people, payload.occasions);
  });

  return {
    ...base,
    text: renderFollowupText(upcoming),
  };
}

interface FollowupItem {
  readonly personName: string;
  readonly occasionLabel: string;
  readonly daysUntil: number;
}

function selectFollowups(
  people: readonly Person[],
  occasions: readonly OccasionNode[],
): readonly FollowupItem[] {
  const peopleById = new Map(people.map((person) => [person.id, person]));
  return occasions
    .filter(
      (occasion) =>
        occasion.daysUntil >= 0 && occasion.daysUntil <= FOLLOWUP_WINDOW_DAYS,
    )
    .map((occasion) => {
      const person = peopleById.get(occasion.personId);
      if (!person) return null;
      return {
        personName: person.name,
        occasionLabel: occasion.label,
        daysUntil: occasion.daysUntil,
      } satisfies FollowupItem;
    })
    .filter((item): item is FollowupItem => item !== null)
    .sort((a, b) => a.daysUntil - b.daysUntil)
    .slice(0, FOLLOWUP_TOP_N);
}

function renderFollowupText(items: readonly FollowupItem[]): string {
  if (items.length === 0) {
    return (
      "Nothing in the next 30 days needs your attention right now. " +
      "Open Keepsake when you want to look ahead further."
    );
  }
  const lines = items.map((item) =>
    `• ${item.personName} — ${item.occasionLabel} in ${renderDays(item.daysUntil)}`,
  );
  return (
    `Here's what's coming up:\n${lines.join("\n")}\n` +
    `Open Keepsake to draft and send when you're ready.`
  );
}

function renderDays(daysUntil: number): string {
  if (daysUntil === 0) return "today";
  if (daysUntil === 1) return "1 day";
  return `${daysUntil} days`;
}
