import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import type { OwnerId } from "@/lib/repositories";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function devKey(): Buffer {
  const encoded = process.env.DEV_ENCRYPTION_KEY_BASE64;
  if (!encoded) {
    throw new Error("DEV_ENCRYPTION_KEY_BASE64 is required for dev crypto envelopes.");
  }

  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("DEV_ENCRYPTION_KEY_BASE64 must decode to 32 bytes for AES-256-GCM.");
  }

  return key;
}

function aad(ownerId: OwnerId, table: string, column: string): Buffer {
  return Buffer.from(`${ownerId}|${table}|${column}`, "utf8");
}

export async function encrypt(
  ownerId: OwnerId,
  table: string,
  column: string,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, devKey(), nonce);
  cipher.setAAD(aad(ownerId, table, column));

  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([nonce, ciphertext, tag]);
}

export async function decrypt(
  ownerId: OwnerId,
  table: string,
  column: string,
  envelope: Uint8Array,
): Promise<Uint8Array> {
  const bytes = Buffer.from(envelope);
  if (bytes.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error("Invalid crypto envelope.");
  }

  const nonce = bytes.subarray(0, NONCE_BYTES);
  const ciphertext = bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, devKey(), nonce);
  decipher.setAAD(aad(ownerId, table, column));
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
}
