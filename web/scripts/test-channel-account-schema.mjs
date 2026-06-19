// Anchor smoke for the P8-B channel-account identity-link design.
//
// No Next.js, no Docker, no DB. Reads the schema draft, the repo
// interface, and the docs, then asserts that the load-bearing
// strings survive future churn:
//
//   * the channel_provider enum and channel_accounts table exist
//   * the unique (provider, external_user_id) index pins identity
//   * RLS is enabled with the standard owner_id policy
//   * the repo interface declares findByProviderUser / listForOwner /
//     link / markRevoked
//   * the docs continue to call out
//       - external_user_id is NOT encrypted by design
//       - display_name_enc IS encrypted
//       - webhook ingest never falls back on the web session
//
// Run via: pnpm test:channel-accounts

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

async function read(rel) {
  try {
    return await readFile(resolve(projectRoot, rel), "utf8");
  } catch (error) {
    process.stdout.write(`could not read ${rel}: ${error?.message ?? error}\n`);
    process.exit(1);
  }
}

const failures = [];
function check(name, cond, detail = "") {
  if (cond) process.stdout.write(`  ✓ ${name}\n`);
  else {
    process.stdout.write(`  ✗ ${name}${detail ? `  (${detail})` : ""}\n`);
    failures.push(name);
  }
}

const schema = await read("db/schema.sql");
const iface = await read("lib/repositories/channel-accounts.ts");
const types = await read("lib/repositories/types.ts");
const barrel = await read("lib/repositories/index.ts");
const dbSchemaDoc = await read("docs/DB_SCHEMA.md");
const archDoc = await read("docs/CURRENT_ARCHITECTURE.md");

process.stdout.write("running channel-account schema anchor assertions:\n");

// ── db/schema.sql ───────────────────────────────────────────────────
check("schema: channel_provider enum exists",
  /CREATE TYPE\s+channel_provider\s+AS\s+ENUM/i.test(schema));
check("schema: channel_provider enum lists whatsapp/telegram/slack/mock",
  /channel_provider[\s\S]{0,200}'whatsapp'[\s\S]{0,100}'telegram'[\s\S]{0,100}'slack'[\s\S]{0,100}'mock'/i.test(schema));
check("schema: channel_account_status enum exists",
  /CREATE TYPE\s+channel_account_status\s+AS\s+ENUM\s*\([^)]*'active'[^)]*'revoked'/i.test(schema));
check("schema: channel_accounts table exists",
  /CREATE TABLE\s+channel_accounts\s*\(/i.test(schema));
check("schema: external_user_id text NOT NULL",
  /external_user_id\s+text\s+NOT NULL/i.test(schema));
check("schema: display_name_enc bytea (encrypted column)",
  /display_name_enc\s+bytea/i.test(schema));
check("schema: raw_profile jsonb NOT NULL DEFAULT '{}'",
  /raw_profile\s+jsonb\s+NOT NULL\s+DEFAULT\s+'\{\}'::jsonb/i.test(schema));
check("schema: UNIQUE (provider, external_user_id) index",
  /CREATE\s+UNIQUE\s+INDEX\s+channel_accounts_provider_user_idx[\s\S]{0,200}\(\s*provider\s*,\s*external_user_id\s*\)/i.test(schema));
check("schema: index (owner_id, provider)",
  /CREATE\s+INDEX\s+channel_accounts_owner_provider_idx[\s\S]{0,200}\(\s*owner_id\s*,\s*provider\s*\)/i.test(schema));
check("schema: partial index (provider, external_thread_id) WHERE non-null",
  /CREATE\s+INDEX\s+channel_accounts_provider_thread_idx[\s\S]{0,200}WHERE\s+external_thread_id\s+IS\s+NOT\s+NULL/i.test(schema));
check("schema: RLS enabled on channel_accounts",
  /ALTER TABLE\s+channel_accounts\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(schema));
check("schema: channel_accounts owner policy uses current_user_id()",
  /CREATE\s+POLICY\s+channel_accounts_owner[\s\S]{0,200}owner_id\s*=\s*current_user_id\(\)/i.test(schema));

// ── lib/repositories/channel-accounts.ts ────────────────────────────
check("interface: ChannelAccountRepository declared",
  /interface\s+ChannelAccountRepository/.test(iface));
check("interface: findByProviderUser exists (no ownerId arg)",
  /findByProviderUser\s*\(\s*provider:\s*ChannelProvider,\s*externalUserId:\s*string/.test(iface));
check("interface: listForOwner exists",
  /listForOwner\s*\(\s*ownerId:\s*OwnerId/.test(iface));
check("interface: link exists",
  /\blink\s*\(\s*ownerId:\s*OwnerId,\s*input:\s*ChannelAccountLinkInput/.test(iface));
check("interface: markRevoked exists",
  /markRevoked\s*\(\s*ownerId:\s*OwnerId,\s*accountId:\s*ChannelAccountId/.test(iface));

// ── lib/repositories/types.ts + barrel ──────────────────────────────
check("types: ChannelAccount domain interface present",
  /interface\s+ChannelAccount\b/.test(types));
check("types: ChannelAccountLinkInput present",
  /interface\s+ChannelAccountLinkInput\b/.test(types));
check("types: displayName: string | null (decrypted at the boundary)",
  /displayName:\s*string\s*\|\s*null/.test(types));
check("barrel: re-exports ChannelAccountRepository",
  /export\s+type\s*\{\s*ChannelAccountRepository\s*\}/.test(barrel));
check("barrel: re-exports ChannelProvider / ChannelAccount domain types",
  /ChannelAccount\b/.test(barrel) && /ChannelProvider\b/.test(barrel));

// ── docs/DB_SCHEMA.md ───────────────────────────────────────────────
check("DB_SCHEMA: documents external_user_id as NOT encrypted",
  /external_user_id[\s\S]{0,200}not\s+encrypted/i.test(dbSchemaDoc));
check("DB_SCHEMA: documents display_name_enc as encrypted",
  /display_name_enc[\s\S]{0,200}encrypted/i.test(dbSchemaDoc));
check("DB_SCHEMA: documents raw_profile no-PII / no-tokens rule",
  /raw_profile[\s\S]{0,400}(no\s+message\s+text|no\s+tokens|non-sensitive)/i.test(dbSchemaDoc));
check("DB_SCHEMA: documents no session fallback for webhook ingest",
  /(channel\s+identity\s+is\s+not\s+web-session\s+auth|MUST NOT fall back[\s\S]{0,80}session)/i.test(dbSchemaDoc));

// ── docs/CURRENT_ARCHITECTURE.md ────────────────────────────────────
check("ARCH: mentions findByProviderUser in the channel flow",
  /findByProviderUser/.test(archDoc));
check("ARCH: spells out no-fallback rule (session / DEV_OWNER_*)",
  /(keepsake_session|DEV_OWNER_\*)[\s\S]{0,200}(MUST NOT|never)|MUST NOT fall back[\s\S]{0,200}(keepsake_session|DEV_OWNER_\*|session)/i.test(archDoc));

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall channel-account schema anchor checks passed\n");
}
