// Create a local `.env.local` from `.env.example` without overwriting by
// default. This is intentionally boring: it keeps onboarding predictable and
// leaves real secrets under the developer's control.
//
// Run via: pnpm env:init

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = process.env.KEEPSAKE_ENV_INIT_ROOT
  ? resolve(process.env.KEEPSAKE_ENV_INIT_ROOT)
  : resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const examplePath = resolve(projectRoot, ".env.example");
const targetPath = resolve(projectRoot, ".env.local");

if (args.has("--help") || args.has("-h")) {
  process.stdout.write("Usage: pnpm env:init [--force]\n");
  process.stdout.write("Creates .env.local from .env.example. Refuses to overwrite unless --force is set.\n");
  process.exit(0);
}

if (!existsSync(examplePath)) {
  process.stderr.write("Cannot initialize env: .env.example was not found.\n");
  process.exit(1);
}

if (existsSync(targetPath) && !force) {
  process.stderr.write(".env.local already exists; leaving it untouched.\n");
  process.stderr.write("Use `pnpm env:init -- --force` to overwrite it from .env.example.\n");
  process.exit(1);
}

mkdirSync(dirname(targetPath), { recursive: true });

if (force) {
  writeFileSync(targetPath, readFileSync(examplePath, "utf8"));
} else {
  copyFileSync(examplePath, targetPath);
}

process.stdout.write(
  `${force ? "Reset" : "Created"} .env.local from .env.example.\n`,
);
process.stdout.write("Review the values before using DB mode or real services.\n");
