import "server-only";

// DB dispatcher for `POST /api/deliveries`.
//
// Validates the request, then under a single `transaction(ownerId, ...)`:
//   1. resolves and authorizes the person + (optional) occasion via the
//      existing draft-context resolver (no new SQL),
//   2. for email channel, asserts the owner has a primary Gmail account in
//      `connected` state — `sender_not_connected` / `sender_expired` otherwise,
//   3. looks up the latest message_draft for the resolved (person, occasion);
//      `no_draft` if none exists,
//   4. enqueues a deliveries row via `DeliveryRepository.enqueue`.
//
// Token revocation, the actual Gmail send, the worker drain loop, and
// provider webhooks are all out of scope. This is the queue boundary, not the
// send pipeline.

import type { DeliveryRequest, OccasionKind } from "@/lib/domain";
import { createDeliveryRepository } from "@/lib/repositories/deliveries.server";
import { createDraftRepository } from "@/lib/repositories/drafts.server";
import { createGmailAccountRepository } from "@/lib/repositories/gmail-accounts.server";
import { currentUserIdOrThrow } from "@/lib/server/auth/current-user.server";
import { transaction } from "@/lib/server/db/transaction.server";
import { resolveDbDraftContextInTx } from "@/lib/server/draft-context/db.server";
import { validateRequest } from "./mock.server";
import type { SendBoundaryResult } from "./types";

const deliveryRepository = createDeliveryRepository();
const draftRepository = createDraftRepository();
const gmailAccountRepository = createGmailAccountRepository();

const DEFAULT_OCCASION_KIND: OccasionKind = "check-in";
const DEFAULT_OCCASION_LABEL = "Check-in";

export async function enqueueDbDelivery(
  input: DeliveryRequest,
): Promise<SendBoundaryResult> {
  const invalid = validateRequest(input);
  if (invalid) return invalid;

  try {
    const ownerId = currentUserIdOrThrow();

    return await transaction(ownerId, async (tx) => {
      // 1. person + occasion ownership through the shared context resolver
      const ctx = await resolveDbDraftContextInTx(
        ownerId,
        {
          personId: input.personId,
          occasionId: input.occasionId,
          userInstruction: "",
        },
        tx,
      );
      if (!ctx.ok) {
        // Drop draft-shaped errors into send-shaped ones. The draft resolver
        // returns 400 for missing fields, 404 for person/occasion, 500 for
        // catalog/internal issues. We've already validated input shape, so
        // the only realistic resolver failure here is 404 or 500.
        if (ctx.status === 404) {
          const code = /occasion/i.test(ctx.error)
            ? "occasion_not_found"
            : "person_not_found";
          return { ok: false, status: 404, code, error: ctx.error };
        }
        return {
          ok: false,
          status: 500,
          code: "service_unavailable",
          error: ctx.error,
        };
      }

      // 2. email sender precondition (post channel has no sender check)
      if (input.channel === "email") {
        const sender = await gmailAccountRepository.getPrimary(ownerId, tx);
        if (!sender) {
          return {
            ok: false,
            status: 409,
            code: "sender_not_connected",
            error: "No Gmail account is connected for this owner.",
          };
        }
        if (sender.status !== "connected") {
          return {
            ok: false,
            status: 409,
            code: "sender_expired",
            error: "The connected Gmail account is not in 'connected' state.",
          };
        }
      }

      // 3. latest draft for (person, occasion)
      const resolvedOccasionId = ctx.ctx.occasion?.id ?? null;
      const latestDraft = await draftRepository.getLatestFor(
        ownerId,
        ctx.ctx.person.id,
        resolvedOccasionId,
        tx,
      );
      if (!latestDraft) {
        return {
          ok: false,
          status: 409,
          code: "no_draft",
          error: "There is no draft to send for this person and occasion.",
        };
      }

      // 4. enqueue
      const queued = await deliveryRepository.enqueue(
        ownerId,
        {
          personId: ctx.ctx.person.id,
          occasionId: resolvedOccasionId,
          draftId: latestDraft.id,
          recipientName: ctx.ctx.person.name,
          occasionKind: ctx.ctx.occasion?.kind ?? DEFAULT_OCCASION_KIND,
          occasionLabel: ctx.ctx.occasion?.label ?? DEFAULT_OCCASION_LABEL,
          channel: input.channel,
        },
        tx,
      );

      return { ok: true, queued };
    });
  } catch (error) {
    console.error(error);
    return {
      ok: false,
      status: 500,
      code: "service_unavailable",
      error: "Delivery enqueue service is unavailable.",
    };
  }
}
