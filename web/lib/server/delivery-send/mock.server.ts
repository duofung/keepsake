import "server-only";

// Mock dispatcher for `POST /api/deliveries`. Validates the request shape and
// returns a synthetic `QueuedDelivery` receipt without touching the DB. It
// deliberately does NOT check sender / person / draft existence — those are
// owner-scoped DB lookups that only the DB path can perform. Mock mode exists
// so that local UI work stays runnable; production behavior lives in the DB
// dispatcher.

import { randomUUID } from "node:crypto";
import type { Channel, DeliveryRequest } from "@/lib/domain";
import type { SendBoundaryResult } from "./types";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MOCK_PERSON_ID_RE = /^p-[a-z0-9-]+$/i;
const MOCK_OCCASION_ID_RE = /^occ-[a-z0-9-]+$/i;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

const VALID_CHANNELS: ReadonlySet<Channel> = new Set(["email", "post"]);

export async function enqueueMockDelivery(
  input: DeliveryRequest,
): Promise<SendBoundaryResult> {
  const validation = validateRequest(input);
  if (validation) return validation;

  return {
    ok: true,
    queued: {
      id: randomUUID(),
      personId: input.personId,
      occasionId: input.occasionId,
      draftId: randomUUID(),
      channel: input.channel,
      status: "queued",
      scheduledForISO: null,
      createdAtISO: new Date().toISOString(),
    },
  };
}

export function validateRequest(input: DeliveryRequest): SendBoundaryResult | null {
  if (!input || typeof input !== "object") {
    return invalid("Request body must be a JSON object.");
  }

  const missing: string[] = [];
  if (!input.personId) missing.push("personId");
  if (!input.channel) missing.push("channel");
  if (missing.length) {
    return invalid(`Missing fields: ${missing.join(", ")}`);
  }

  if (
    typeof input.personId !== "string" ||
    (!UUID_RE.test(input.personId) && !MOCK_PERSON_ID_RE.test(input.personId))
  ) {
    return invalid("personId must be a UUID or mock person id.");
  }

  if (input.occasionId !== null && input.occasionId !== undefined) {
    if (
      typeof input.occasionId !== "string" ||
      (!UUID_RE.test(input.occasionId) && !MOCK_OCCASION_ID_RE.test(input.occasionId))
    ) {
      return invalid("occasionId must be a UUID, mock occasion id, or null.");
    }
  }

  if (!VALID_CHANNELS.has(input.channel)) {
    return invalid('channel must be "email" or "post".');
  }

  // recipientEmail is required for the email channel and must look like an
  // address. Post-channel callers may include it (ignored) or omit it.
  if (input.channel === "email") {
    const value = input.recipientEmail;
    if (typeof value !== "string" || value.length === 0) {
      return invalid("recipientEmail is required for the email channel.");
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(trimmed)) {
      return invalid("recipientEmail must be a valid email address.");
    }
  }

  return null;
}

/**
 * Trimmed, validated recipient email for the email channel. Returns `null`
 * for non-email channels so call sites can pass it straight to enqueue
 * without re-validating. Assumes `validateRequest` has already passed.
 */
export function normalizedRecipientEmail(input: DeliveryRequest): string | null {
  if (input.channel !== "email") return null;
  return typeof input.recipientEmail === "string" ? input.recipientEmail.trim() : null;
}

function invalid(error: string): SendBoundaryResult {
  return { ok: false, status: 400, code: "invalid_request", error };
}
