import "server-only";

import type { OwnerId } from "@/lib/repositories";
import { createChannelAccountRepository } from "@/lib/repositories/channel-accounts.server";
import { workerTransaction } from "@/lib/server/db/transaction.server";
import { handleOwnerCommand } from "./command-service.server";
import type { CommandEvent, CommandResponse } from "./types";
import {
  extractWhatsAppLinkToken,
  linkWhatsAppAccountFromLinkToken,
} from "./whatsapp-link-token.server";

type WhatsAppWebhookPayload = Record<string, unknown>;

export type WhatsAppInboundResult =
  | {
      readonly status: 400 | 401 | 501;
      readonly body: {
        readonly code: "invalid_request" | "not_configured" | "unauthorized";
        readonly detail?: string;
      };
    }
  | {
      readonly status: 200;
      readonly body: WhatsAppInboundResponse;
    };

export type WhatsAppInboundResponse =
  | {
      readonly status: "ignored";
      readonly intent: "unknown";
      readonly code: "ignored";
      readonly text: string;
    }
  | {
      readonly status: "needs_link";
      readonly intent: "unknown";
      readonly code:
        | "needs_link"
        | "invalid_link"
        | "expired_link"
        | "already_linked"
        | "not_configured";
      readonly text: string;
      readonly reviewUrl: string;
    }
  | {
      readonly status: "ok";
      readonly intent: "unknown";
      readonly code: "linked";
      readonly text: string;
      readonly reviewUrl: string;
    }
  | CommandResponse;

interface WhatsAppMessageContext {
  readonly externalUserId: string;
  readonly externalThreadId: string;
  readonly text: string;
  readonly receivedAtISO: string;
  readonly displayName: string | null;
  readonly rawProfile: Record<string, unknown> | null;
}

const WHATSAPP_SECRET_HEADER = "x-whatsapp-webhook-secret";
const LINK_NEEDED_TEXT =
  "Link WhatsApp in ReMaster before I can help from here.";
const IGNORED_TEXT = "Only WhatsApp text messages are supported right now.";

export async function handleWhatsAppInboundUpdate(
  input: unknown,
  headers: Headers,
): Promise<WhatsAppInboundResult> {
  const secret = readRequiredEnv("WHATSAPP_WEBHOOK_SECRET");
  if (!secret) return notConfigured("WHATSAPP_WEBHOOK_SECRET is required.");

  if (headers.get(WHATSAPP_SECRET_HEADER) !== secret) {
    return {
      status: 401,
      body: { code: "unauthorized" },
    };
  }

  if (dataSource() !== "db") {
    return notConfigured(
      "WhatsApp inbound requires KEEPSAKE_DATA_SOURCE=db.",
    );
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return invalid("body must be an object");
  }

  const payload = input as WhatsAppWebhookPayload;
  const message = extractMessage(payload);
  if (!message) {
    return ignored();
  }

  const linkToken = extractWhatsAppLinkToken(message.text);
  if (linkToken) {
    return handleWhatsAppLinkToken(message, linkToken);
  }

  const account = await workerTransaction((tx) =>
    createChannelAccountRepository().findByProviderUser(
      "whatsapp",
      message.externalUserId,
      tx,
    ),
  );

  if (!account || account.status === "revoked") {
    return {
      status: 200,
      body: {
        status: "needs_link",
        intent: "unknown",
        code: "needs_link",
        text: LINK_NEEDED_TEXT,
        reviewUrl: "/profile#command-channels",
      },
    };
  }

  const event: CommandEvent = {
    provider: "whatsapp",
    externalUserId: message.externalUserId,
    externalThreadId: message.externalThreadId,
    text: message.text,
    receivedAtISO: message.receivedAtISO,
    raw: payload,
  };

  const response = await handleOwnerCommand(account.ownerId as OwnerId, event);
  return {
    status: 200,
    body: response,
  };
}

async function handleWhatsAppLinkToken(
  message: WhatsAppMessageContext,
  token: string,
): Promise<WhatsAppInboundResult> {
  const result = await linkWhatsAppAccountFromLinkToken({
    token,
    externalUserId: message.externalUserId,
    externalThreadId: message.externalThreadId,
    displayName: message.displayName,
    rawProfile: message.rawProfile,
  });

  if (result.ok) {
    return {
      status: 200,
      body: {
        status: "ok",
        intent: "unknown",
        code: "linked",
        text: result.text,
        reviewUrl: result.reviewUrl,
      },
    };
  }

  return {
    status: 200,
    body: {
      status: "needs_link",
      intent: "unknown",
      code: result.code,
      text: result.text,
      reviewUrl: result.reviewUrl,
    },
  };
}

function extractMessage(
  payload: WhatsAppWebhookPayload,
): WhatsAppMessageContext | null {
  for (const entry of arrayOrEmpty(payload.entry)) {
    const entryObject = objectOrNull(entry);
    if (!entryObject) continue;

    for (const change of arrayOrEmpty(entryObject.changes)) {
      const changeObject = objectOrNull(change);
      const value = objectOrNull(changeObject?.value);
      if (!value) continue;

      const metadata = objectOrNull(value.metadata);
      const phoneNumberId = stringOrNull(metadata?.phone_number_id);
      const contacts = arrayOrEmpty(value.contacts);

      for (const candidate of arrayOrEmpty(value.messages)) {
        const message = objectOrNull(candidate);
        if (!message) continue;
        if (stringOrNull(message.type) !== "text") continue;

        const textObject = objectOrNull(message.text);
        const text = stringOrNull(textObject?.body)?.trim();
        const externalUserId = stringOrNull(message.from)?.trim();
        if (!text || !externalUserId) continue;

        return {
          externalUserId,
          externalThreadId: whatsappThreadId(phoneNumberId, externalUserId),
          text,
          receivedAtISO: whatsappTimestampISO(message.timestamp),
          displayName: whatsappDisplayName(contacts, externalUserId),
          rawProfile: whatsappRawProfile(contacts, externalUserId),
        };
      }
    }
  }

  return null;
}

function whatsappThreadId(
  phoneNumberId: string | null,
  externalUserId: string,
): string {
  return phoneNumberId ? `${phoneNumberId}:${externalUserId}` : externalUserId;
}

function whatsappTimestampISO(value: unknown): string {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : new Date().toISOString();
}

function whatsappDisplayName(
  contacts: readonly unknown[],
  externalUserId: string,
): string | null {
  const profile = whatsappRawProfile(contacts, externalUserId);
  const name = stringOrNull(objectOrNull(profile?.profile)?.name)?.trim();
  return name || null;
}

function whatsappRawProfile(
  contacts: readonly unknown[],
  externalUserId: string,
): Record<string, unknown> | null {
  for (const candidate of contacts) {
    const contact = objectOrNull(candidate);
    if (!contact) continue;
    if (stringOrNull(contact.wa_id)?.trim() === externalUserId) {
      return contact;
    }
  }
  const fallback = objectOrNull(contacts[0]);
  return fallback ?? null;
}

function invalid(detail: string): WhatsAppInboundResult {
  return {
    status: 400,
    body: { code: "invalid_request", detail },
  };
}

function ignored(): WhatsAppInboundResult {
  return {
    status: 200,
    body: {
      status: "ignored",
      intent: "unknown",
      code: "ignored",
      text: IGNORED_TEXT,
    },
  };
}

function notConfigured(detail: string): WhatsAppInboundResult {
  return {
    status: 501,
    body: { code: "not_configured", detail },
  };
}

function readRequiredEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayOrEmpty(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function dataSource(): "mock" | "db" {
  return process.env.KEEPSAKE_DATA_SOURCE === "db" ? "db" : "mock";
}
