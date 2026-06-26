import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChannelAccount, OwnerId } from "@/lib/repositories";
import { createChannelAccountRepository } from "@/lib/repositories/channel-accounts.server";

const MIN_SECRET_LENGTH = 32;
const TOKEN_TTL_SECONDS = 15 * 60;
const UUID_B64_LENGTH = 22;
const EXP_B36_LENGTH = 8;
const SIG_LENGTH = 22;
const TOKEN_LENGTH = UUID_B64_LENGTH + EXP_B36_LENGTH + SIG_LENGTH;

const TOKEN_RE = /^[A-Za-z0-9_-]{52}$/;
const PHONE_RE = /^\d{8,15}$/;

export interface WhatsAppLink {
  readonly status: "ready";
  readonly url: string;
  readonly message: string;
  readonly expiresAtISO: string;
}

export interface WhatsAppLinkUnavailable {
  readonly status: "not_configured";
  readonly detail: string;
}

export type WhatsAppLinkView = WhatsAppLink | WhatsAppLinkUnavailable;

export function createWhatsAppLinkForOwner(
  ownerId: OwnerId,
  nowMs: number = Date.now(),
): WhatsAppLinkView {
  const phoneNumber = readLinkPhoneNumber();
  if (!phoneNumber) {
    return {
      status: "not_configured",
      detail: "Set WHATSAPP_LINK_PHONE_NUMBER to generate a WhatsApp link.",
    };
  }

  const token = createWhatsAppLinkToken(ownerId, nowMs);
  if (!token) {
    return {
      status: "not_configured",
      detail: "APP_SESSION_SIGNING_SECRET is required for WhatsApp links.",
    };
  }

  const message = `Link ReMaster ${token}`;
  return {
    status: "ready",
    url: `https://wa.me/${phoneNumber}?text=${encodeURIComponent(message)}`,
    message,
    expiresAtISO: new Date(nowMs + TOKEN_TTL_SECONDS * 1000).toISOString(),
  };
}

export interface WhatsAppLinkTokenInput {
  readonly token: string;
  readonly externalUserId: string;
  readonly externalThreadId: string | null;
  readonly displayName: string | null;
  readonly rawProfile: Record<string, unknown> | null;
  readonly nowMs?: number;
}

export type WhatsAppLinkTokenResult =
  | {
      readonly ok: true;
      readonly account: ChannelAccount;
      readonly text: string;
      readonly reviewUrl: string;
    }
  | {
      readonly ok: false;
      readonly code:
        | "invalid_link"
        | "expired_link"
        | "already_linked"
        | "not_configured";
      readonly text: string;
      readonly reviewUrl: string;
    };

export async function linkWhatsAppAccountFromLinkToken(
  input: WhatsAppLinkTokenInput,
): Promise<WhatsAppLinkTokenResult> {
  const verified = verifyWhatsAppLinkToken(input.token, input.nowMs ?? Date.now());
  if (!verified.ok) {
    if (verified.code === "not_configured") {
      return {
        ok: false,
        code: "not_configured",
        text: "WhatsApp linking is not configured. Open ReMaster to manage command channels.",
        reviewUrl: "/profile#command-channels",
      };
    }
    return {
      ok: false,
      code: verified.code,
      text: verified.code === "expired_link"
        ? "That WhatsApp link expired. Open ReMaster to generate a fresh link."
        : "That WhatsApp link is not valid. Open ReMaster to generate a fresh link.",
      reviewUrl: "/profile#command-channels",
    };
  }

  try {
    const account = await createChannelAccountRepository().link(verified.ownerId, {
      provider: "whatsapp",
      externalUserId: input.externalUserId,
      externalThreadId: input.externalThreadId ?? undefined,
      displayName: input.displayName,
      rawProfile: input.rawProfile ?? undefined,
    });
    return {
      ok: true,
      account,
      text: "WhatsApp is linked to ReMaster. You can now ask about account/contact follow-ups from here.",
      reviewUrl: "/profile#command-channels",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/cross_owner_conflict/i.test(message)) {
      return {
        ok: false,
        code: "already_linked",
        text: "This WhatsApp account is already linked to a different ReMaster workspace.",
        reviewUrl: "/profile#command-channels",
      };
    }
    throw error;
  }
}

export function extractWhatsAppLinkToken(text: string): string | null {
  const match = text.trim().match(
    /^(?:link\s+remaster|remaster\s+link|link|connect|start)\s+([A-Za-z0-9_-]{20,80})$/i,
  );
  return match?.[1] ?? null;
}

function createWhatsAppLinkToken(
  ownerId: OwnerId,
  nowMs: number,
): string | null {
  const secret = readSigningSecret();
  if (!secret) return null;
  const uuidB64 = uuidToBase64url(ownerId);
  if (!uuidB64) return null;
  const expB36 = Math.floor((nowMs + TOKEN_TTL_SECONDS * 1000) / 1000)
    .toString(36)
    .padStart(EXP_B36_LENGTH, "0")
    .slice(-EXP_B36_LENGTH);
  const payload = `${uuidB64}${expB36}`;
  const sig = hmac(payload, secret).slice(0, SIG_LENGTH);
  return `${payload}${sig}`;
}

function verifyWhatsAppLinkToken(
  token: string,
  nowMs: number,
): (
  | { readonly ok: true; readonly ownerId: OwnerId }
  | { readonly ok: false; readonly code: "invalid_link" | "expired_link" | "not_configured" }
) {
  const secret = readSigningSecret();
  if (!secret) return { ok: false, code: "not_configured" };
  const trimmed = token.trim();
  if (!TOKEN_RE.test(trimmed) || trimmed.length !== TOKEN_LENGTH) {
    return { ok: false, code: "invalid_link" };
  }

  const payload = trimmed.slice(0, UUID_B64_LENGTH + EXP_B36_LENGTH);
  const signature = trimmed.slice(UUID_B64_LENGTH + EXP_B36_LENGTH);
  const expected = hmac(payload, secret).slice(0, SIG_LENGTH);
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, code: "invalid_link" };
  }

  const ownerId = uuidFromBase64url(payload.slice(0, UUID_B64_LENGTH));
  const expSeconds = Number.parseInt(payload.slice(UUID_B64_LENGTH), 36);
  if (!ownerId || !Number.isFinite(expSeconds)) {
    return { ok: false, code: "invalid_link" };
  }
  if (nowMs >= expSeconds * 1000) {
    return { ok: false, code: "expired_link" };
  }
  return { ok: true, ownerId };
}

function hmac(payload: string, secret: Buffer): string {
  return base64url(createHmac("sha256", secret).update(`whatsapp-link:${payload}`).digest());
}

function readSigningSecret(): Buffer | null {
  const raw = process.env.APP_SESSION_SIGNING_SECRET?.trim() ?? "";
  if (raw.length < MIN_SECRET_LENGTH) return null;
  return Buffer.from(raw, "utf8");
}

function readLinkPhoneNumber(): string | null {
  const raw = process.env.WHATSAPP_LINK_PHONE_NUMBER?.trim() ?? "";
  const normalized = raw.replace(/^\+/, "").replace(/[^\d]/g, "");
  return PHONE_RE.test(normalized) ? normalized : null;
}

function uuidToBase64url(ownerId: string): string | null {
  const hex = ownerId.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
  return base64url(Buffer.from(hex, "hex"));
}

function uuidFromBase64url(value: string): OwnerId | null {
  let bytes: Buffer;
  try {
    bytes = fromBase64url(value);
  } catch {
    return null;
  }
  if (bytes.length !== 16) return null;
  const hex = bytes.toString("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-`
    + `${hex.slice(16, 20)}-${hex.slice(20)}`
  ) as OwnerId;
}

function base64url(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(text: string): Buffer {
  const padded = text
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}
