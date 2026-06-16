// Preflight for `pnpm dev`.
//
// Next loads `.env*` files after it starts. This guard runs before `next dev`,
// so it mirrors the small subset of Next env loading needed to catch common
// local setup mistakes with a clear message.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_TEXT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ENV_FILES = [
  ".env",
  ".env.development",
  ".env.local",
  ".env.development.local",
];

function readEnvFiles() {
  const env = {};
  const loaded = [];

  for (const file of ENV_FILES) {
    const path = resolve(projectRoot, file);
    if (!existsSync(path)) continue;

    Object.assign(env, parseEnv(readFileSync(path, "utf8")));
    loaded.push(file);
  }

  return {
    env: { ...env, ...process.env },
    loaded,
  };
}

function parseEnv(source) {
  const env = {};

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equals = withoutExport.indexOf("=");
    if (equals === -1) continue;

    const key = withoutExport.slice(0, equals).trim();
    if (!key) continue;

    env[key] = cleanValue(withoutExport.slice(equals + 1).trim());
  }

  return env;
}

function cleanValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  const commentAt = value.search(/\s#/);
  return commentAt === -1 ? value : value.slice(0, commentAt).trimEnd();
}

function validate(env) {
  const errors = [];
  const source = (env.KEEPSAKE_DATA_SOURCE || "mock").trim();

  if (!["mock", "db"].includes(source)) {
    errors.push("KEEPSAKE_DATA_SOURCE must be either 'mock' or 'db'.");
  }

  const ownerId = (env.DEV_OWNER_ID || "").trim();
  const ownerEmail = (env.DEV_OWNER_EMAIL || "").trim();
  const ownerName = (env.DEV_OWNER_NAME || "").trim();

  if (!ownerId) {
    errors.push("DEV_OWNER_ID is required for Home, Profile, and /api/session.");
  } else if (!UUID_TEXT.test(ownerId)) {
    errors.push("DEV_OWNER_ID must be a valid UUID.");
  }

  if (!ownerEmail) {
    errors.push("DEV_OWNER_EMAIL is required for Home, Profile, and /api/session.");
  } else if (!EMAIL_TEXT.test(ownerEmail)) {
    errors.push("DEV_OWNER_EMAIL must be a valid email.");
  }

  if (!ownerName) {
    errors.push("DEV_OWNER_NAME is required for Home, Profile, and /api/session.");
  }

  if (source === "db") {
    const databaseUrl = (env.DATABASE_URL || "").trim();
    if (!databaseUrl) {
      errors.push("DATABASE_URL is required when KEEPSAKE_DATA_SOURCE=db.");
    }

    const key = (env.DEV_ENCRYPTION_KEY_BASE64 || "").trim();
    if (!key) {
      errors.push("DEV_ENCRYPTION_KEY_BASE64 is required when KEEPSAKE_DATA_SOURCE=db.");
    } else if (!decodesTo32Bytes(key)) {
      errors.push("DEV_ENCRYPTION_KEY_BASE64 must decode to 32 bytes.");
    }
  }

  return { errors, source };
}

function decodesTo32Bytes(value) {
  try {
    return Buffer.from(value, "base64").length === 32;
  } catch {
    return false;
  }
}

function printFailure(errors, loaded) {
  process.stderr.write("Keepsake dev env is not ready.\n\n");
  process.stderr.write("Fix these values before running `pnpm dev`:\n");
  for (const error of errors) {
    process.stderr.write(`  - ${error}\n`);
  }

  process.stderr.write("\nCreate `.env.local` or export the variables in your shell.\n");
  process.stderr.write("For mock-mode UI work, this is enough:\n\n");
  process.stderr.write("DEV_OWNER_ID=00000000-0000-4000-8000-000000000001\n");
  process.stderr.write("DEV_OWNER_EMAIL=arthur@example.test\n");
  process.stderr.write("DEV_OWNER_NAME=Arthur\n");
  process.stderr.write("KEEPSAKE_DATA_SOURCE=mock\n\n");
  process.stderr.write("For DB mode, also set DATABASE_URL and DEV_ENCRYPTION_KEY_BASE64.\n");
  process.stderr.write(`Loaded env files: ${loaded.length ? loaded.join(", ") : "none"}\n`);
  process.stderr.write("Note: `.env.example` is documentation only and is not loaded by this guard.\n");
}

const { env, loaded } = readEnvFiles();
const { errors, source } = validate(env);

if (errors.length) {
  printFailure(errors, loaded);
  process.exit(1);
}

process.stdout.write(
  `Keepsake dev env ok (KEEPSAKE_DATA_SOURCE=${source}; loaded ${loaded.length ? loaded.join(", ") : "no .env files"}).\n`,
);
