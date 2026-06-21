import "server-only";

import type { OwnerId } from "@/lib/repositories";
import { createChannelAccountRepository } from "@/lib/repositories/channel-accounts.server";
import { workerTransaction } from "@/lib/server/db/transaction.server";
import { handleOwnerCommand } from "./command-service.server";
import {
  extractTelegramStartToken,
  linkTelegramAccountFromStartToken,
} from "./telegram-start-token.server";
import type { CommandEvent, CommandResponse } from "./types";

type TelegramUpdate = Record<string, unknown>;

export type TelegramInboundResult =
  | {
      readonly status: 400 | 401 | 501 | 502;
      readonly body: {
        readonly code:
          | "invalid_request"
          | "not_configured"
          | "unauthorized"
          | "telegram_send_failed";
        readonly detail?: string;
      };
    }
  | {
      readonly status: 200;
      readonly body: TelegramInboundResponse;
    };

export type TelegramInboundResponse =
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
      readonly telegram: TelegramSendReceipt;
    }
  | {
      readonly status: "ok";
      readonly intent: "unknown";
      readonly code: "linked";
      readonly text: string;
      readonly reviewUrl: string;
      readonly telegram: TelegramSendReceipt;
    }
  | (CommandResponse & {
      readonly telegram: TelegramSendReceipt;
    });

interface TelegramSendReceipt {
  readonly sent: true;
  readonly chatId: string;
  readonly providerMessageId: string | null;
}

interface TelegramConfig {
  readonly webhookSecret: string;
  readonly botToken: string;
  readonly appOrigin: string;
  readonly apiBase: string;
}

interface TelegramMessageContext {
  readonly chatId: string;
  readonly externalUserId: string;
  readonly externalThreadId: string;
  readonly text: string;
  readonly receivedAtISO: string;
  readonly displayName: string | null;
  readonly rawProfile: Record<string, unknown> | null;
}

const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";
const LINK_NEEDED_TEXT =
  "Link Telegram in Keepsake before I can help from here.";
const IGNORED_TEXT = "Only text messages are supported right now.";
const NO_EXECUTION_TEXT =
  "Keepsake will never send from Telegram. Review and finish in the web app.";

export async function handleTelegramInboundUpdate(
  input: unknown,
  headers: Headers,
): Promise<TelegramInboundResult> {
  const secret = readRequiredEnv("TELEGRAM_WEBHOOK_SECRET");
  if (!secret) return notConfigured("TELEGRAM_WEBHOOK_SECRET is required.");

  if (headers.get(TELEGRAM_SECRET_HEADER) !== secret) {
    return {
      status: 401,
      body: { code: "unauthorized" },
    };
  }

  if (dataSource() !== "db") {
    return notConfigured(
      "Telegram inbound requires KEEPSAKE_DATA_SOURCE=db.",
    );
  }

  const botToken = readRequiredEnv("TELEGRAM_BOT_TOKEN");
  if (!botToken) return notConfigured("TELEGRAM_BOT_TOKEN is required.");

  const appOrigin = normaliseOrigin(process.env.KEEPSAKE_APP_ORIGIN);
  if (!appOrigin) return notConfigured("KEEPSAKE_APP_ORIGIN is required.");

  const config: TelegramConfig = {
    webhookSecret: secret,
    botToken,
    appOrigin,
    apiBase: normaliseApiBase(process.env.TELEGRAM_API_BASE),
  };

  if (!input || typeof input !== "object") {
    return invalid("body must be an object");
  }

  const update = input as TelegramUpdate;
  const message = extractMessage(update);
  if (!message) {
    return ignored();
  }

  const startToken = extractTelegramStartToken(message.text);
  if (startToken) {
    return handleTelegramStartLink(config, message, startToken);
  }

  const account = await workerTransaction((tx) =>
    createChannelAccountRepository().findByProviderUser(
      "telegram",
      message.externalUserId,
      tx,
    ),
  );

  if (!account || account.status === "revoked") {
    const reviewUrl = "/profile#command-channels";
    const receipt = await sendTelegramMessage(
      config,
      message.chatId,
      renderTelegramText({
        text: LINK_NEEDED_TEXT,
        reviewUrl,
        config,
      }),
    );
    return {
      status: 200,
      body: {
        status: "needs_link",
        intent: "unknown",
        code: "needs_link",
        text: LINK_NEEDED_TEXT,
        reviewUrl,
        telegram: receipt,
      },
    };
  }

  const event: CommandEvent = {
    provider: "telegram",
    externalUserId: message.externalUserId,
    externalThreadId: message.externalThreadId,
    text: message.text,
    receivedAtISO: message.receivedAtISO,
    raw: update,
  };

  const response = await handleOwnerCommand(account.ownerId as OwnerId, event);
  const receipt = await sendTelegramMessage(
    config,
    message.chatId,
    renderTelegramText({
      text: response.text,
      reviewUrl: response.reviewUrl,
      config,
    }),
  );

  return {
    status: 200,
    body: {
      ...response,
      telegram: receipt,
    },
  };
}

function extractMessage(update: TelegramUpdate): TelegramMessageContext | null {
  const message = objectOrNull(update.message);
  if (!message) return null;

  const text = stringOrNull(message.text)?.trim();
  if (!text) return null;

  const from = objectOrNull(message.from);
  const fromId = idToString(from?.id);
  if (!fromId) return null;
  const displayName = telegramDisplayName(from);

  const chat = objectOrNull(message.chat);
  const chatId = idToString(chat?.id);
  if (!chatId) return null;

  const dateSeconds = numberOrNull(message.date);
  const receivedAtISO = Number.isFinite(dateSeconds)
    ? new Date(dateSeconds * 1000).toISOString()
    : new Date().toISOString();

  return {
    chatId,
    externalUserId: fromId,
    externalThreadId: chatId,
    text,
    receivedAtISO,
    displayName,
    rawProfile: from,
  };
}

async function handleTelegramStartLink(
  config: TelegramConfig,
  message: TelegramMessageContext,
  token: string,
): Promise<TelegramInboundResult> {
  const result = await linkTelegramAccountFromStartToken({
    token,
    externalUserId: message.externalUserId,
    externalThreadId: message.externalThreadId,
    displayName: message.displayName,
    rawProfile: message.rawProfile,
  });
  const receipt = await sendTelegramMessage(
    config,
    message.chatId,
    renderTelegramText({
      text: result.text,
      reviewUrl: result.reviewUrl,
      config,
    }),
  );

  if (result.ok) {
    return {
      status: 200,
      body: {
        status: "ok",
        intent: "unknown",
        code: "linked",
        text: result.text,
        reviewUrl: result.reviewUrl,
        telegram: receipt,
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
      telegram: receipt,
    },
  };
}

async function sendTelegramMessage(
  config: TelegramConfig,
  chatId: string,
  text: string,
): Promise<TelegramSendReceipt> {
  const url = `${config.apiBase}/bot${config.botToken}/sendMessage`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
  } catch {
    throwTelegramSendFailed();
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Handled by the shape check below.
  }

  const bodyObject = objectOrNull(body);
  const result = objectOrNull(bodyObject?.result);
  const messageId = idToString(result?.message_id);
  if (!res.ok || bodyObject?.ok !== true || !messageId) {
    throwTelegramSendFailed();
  }

  return {
    sent: true,
    chatId,
    providerMessageId: messageId,
  };
}

function renderTelegramText(input: {
  readonly text: string;
  readonly reviewUrl?: string;
  readonly config: TelegramConfig;
}): string {
  const lines = [input.text.trim()];
  if (input.reviewUrl) {
    lines.push(`Review in Keepsake: ${absoluteReviewUrl(input.config, input.reviewUrl)}`);
  }
  lines.push(NO_EXECUTION_TEXT);
  return lines.join("\n\n");
}

function absoluteReviewUrl(config: TelegramConfig, reviewUrl: string): string {
  if (/^https?:\/\//i.test(reviewUrl)) return reviewUrl;
  const path = reviewUrl.startsWith("/") ? reviewUrl : `/${reviewUrl}`;
  return `${config.appOrigin}${path}`;
}

function throwTelegramSendFailed(): never {
  throw {
    status: 502,
    body: {
      code: "telegram_send_failed",
      detail: "Telegram sendMessage failed.",
    },
  } satisfies TelegramInboundResult;
}

export function telegramFailureResponse(error: unknown): TelegramInboundResult | null {
  if (
    error
    && typeof error === "object"
    && "status" in error
    && "body" in error
  ) {
    const result = error as TelegramInboundResult;
    if (result.status === 502) return result;
  }
  return null;
}

function invalid(detail: string): TelegramInboundResult {
  return {
    status: 400,
    body: { code: "invalid_request", detail },
  };
}

function ignored(): TelegramInboundResult {
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

function notConfigured(detail: string): TelegramInboundResult {
  return {
    status: 501,
    body: { code: "not_configured", detail },
  };
}

function readRequiredEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function normaliseOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function normaliseApiBase(value: string | undefined): string {
  return (value?.trim() || "https://api.telegram.org").replace(/\/+$/, "");
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function telegramDisplayName(from: Record<string, unknown> | null): string | null {
  if (!from) return null;
  const first = stringOrNull(from.first_name)?.trim();
  const last = stringOrNull(from.last_name)?.trim();
  const username = stringOrNull(from.username)?.trim();
  const name = [first, last].filter(Boolean).join(" ").trim();
  if (name) return name;
  return username ? `@${username}` : null;
}

function numberOrNull(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

function idToString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function dataSource(): "mock" | "db" {
  return process.env.KEEPSAKE_DATA_SOURCE === "db" ? "db" : "mock";
}
