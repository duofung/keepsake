// DB-backed smoke for PgChannelAccountRepository (P8-C runtime).
//
// Boots throwaway Postgres, loads the schema, creates an app role
// (NOBYPASSRLS) for the user-scoped transactions and an admin role
// (BYPASSRLS) wired into the worker pool for findByProviderUser /
// link's cross-owner conflict check.
//
// Asserts:
//   * link → row appears in listForOwner with decrypted displayName
//   * cross-owner listForOwner doesn't see the link
//   * findByProviderUser through a worker tx returns the link
//   * findByProviderUser without a tx throws
//   * findByProviderUser for unknown identity → null
//   * re-link (same owner) is idempotent on id, refreshes
//     displayName/threadId/rawProfile/status='active', flips revoked
//     back to active
//   * markRevoked sets status=revoked, listForOwner still includes it
//   * cross-owner / unknown markRevoked throws not-found
//   * cross-owner link attempt throws a cross_owner_conflict-tagged error
//   * raw `display_name_enc` bytes never contain the plaintext name
//   * raw_profile round-trips harmless jsonb metadata
//
// Run via: pnpm test:db:channel-accounts

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = normalize(join(__dirname, ".."));
const containerName = `keepsake-test-channel-accounts-${Date.now()}`;
const postgresImage = "postgres:17-alpine";
const appRole = "keepsake_app";
const appPassword = "keepsake_app";

let containerStarted = false;
let helperClose = async () => {};
let helperCleanup = async () => {};

function cmd(commandName, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${commandName} ${args.join(" ")} failed: ${stderr || stdout}`));
    });
  });
}
async function docker(args) { return cmd("docker", args); }

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 45_000;
  let lastError = null;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      await delay(500);
    }
  }
  throw new Error(`Postgres did not become ready: ${lastError?.message ?? "unknown"}`);
}

async function withClient(databaseUrl, fn) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

async function runSqlFile(databaseUrl, path) {
  const sql = await readFile(join(projectRoot, path), "utf8");
  await withClient(databaseUrl, (client) => client.query(sql));
}

function transpile(sourcePath, source) {
  return ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

async function loadRepository() {
  const tempRoot = join(projectRoot, ".next", "test-channel-accounts-repository");
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, "run-"));
  helperCleanup = () => rm(tempDir, { force: true, recursive: true });

  const txSrcPath = join(projectRoot, "lib/server/db/transaction.server.ts");
  const txSrc = (await readFile(txSrcPath, "utf8"))
    .replace(/^import "server-only";\n/, "")
    .concat(`
export async function __closePoolForTest() {
  if (pool) { await pool.end(); pool = null; }
  if (workerPool) { await workerPool.end(); workerPool = null; }
}
`);
  const txOut = join(tempDir, "transaction.server.cjs");
  await writeFile(txOut, transpile(txSrcPath, txSrc));

  const envSrcPath = join(projectRoot, "lib/server/crypto/envelope.server.ts");
  const envSrc = (await readFile(envSrcPath, "utf8"))
    .replace(/^import "server-only";\n/, "");
  const envOut = join(tempDir, "envelope.server.cjs");
  await writeFile(envOut, transpile(envSrcPath, envSrc));

  const repoSrcPath = join(projectRoot, "lib/repositories/channel-accounts.server.ts");
  const repoSrc = (await readFile(repoSrcPath, "utf8"))
    .replace(/^import "server-only";\n/, "")
    .replace(/from "@\/lib\/server\/db\/transaction\.server"/g, 'from "./transaction.server.cjs"')
    .replace(/from "@\/lib\/server\/crypto\/envelope\.server"/g, 'from "./envelope.server.cjs"');
  const repoOut = join(tempDir, "channel-accounts.server.cjs");
  await writeFile(repoOut, transpile(repoSrcPath, repoSrc));

  const require = createRequire(import.meta.url);
  const db = require(txOut);
  const envelope = require(envOut);
  const mod = require(repoOut);

  if (typeof db.transaction !== "function") throw new Error("transaction missing");
  if (typeof db.workerTransaction !== "function") throw new Error("workerTransaction missing");
  if (typeof db.__closePoolForTest !== "function") throw new Error("pool cleanup hook missing");
  if (typeof mod.createChannelAccountRepository !== "function") {
    throw new Error("channel-accounts.server.ts did not export createChannelAccountRepository()");
  }

  helperClose = db.__closePoolForTest;
  return { db, decrypt: envelope.decrypt, repo: mod.createChannelAccountRepository() };
}

function assert(condition, label, detail = "") {
  if (!condition) throw new Error(`${label}${detail ? `: ${detail}` : ""}`);
  process.stdout.write(`  ✓ ${label}\n`);
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
async function expectReject(fn, matcher, label) {
  try {
    await fn();
  } catch (error) {
    const message = error?.message ?? String(error);
    if (matcher && !matcher.test(message)) {
      throw new Error(`${label}: rejection message "${message}" did not match ${matcher}`);
    }
    process.stdout.write(`  ✓ ${label}\n`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

async function rawRow(databaseUrl, id) {
  return withClient(databaseUrl, async (client) => {
    const r = await client.query(
      `SELECT id::text, owner_id::text, provider::text, external_user_id, external_thread_id,
              display_name_enc, status::text, raw_profile
       FROM channel_accounts WHERE id = $1::uuid`,
      [id],
    );
    return r.rows[0] ?? null;
  });
}

try {
  process.stdout.write("checking Docker availability:\n");
  await docker(["--version"]);
  process.stdout.write("  ✓ docker CLI is available\n");

  process.stdout.write(`starting ${postgresImage}:\n`);
  await docker([
    "run", "--rm", "-d", "--name", containerName,
    "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=keepsake",
    "-p", "127.0.0.1::5432", postgresImage,
  ]);
  containerStarted = true;

  const portOutput = await docker(["port", containerName, "5432/tcp"]);
  const pgPort = portOutput.stdout.trim().split(":").pop();
  const adminUrl = `postgres://postgres:postgres@127.0.0.1:${pgPort}/keepsake`;
  const appUrl   = `postgres://${appRole}:${appPassword}@127.0.0.1:${pgPort}/keepsake`;

  await waitForPostgres(adminUrl);
  process.stdout.write("  ✓ postgres is accepting connections\n");

  process.stdout.write("loading schema:\n");
  await runSqlFile(adminUrl, "db/schema.sql");

  await withClient(adminUrl, async (client) => {
    await client.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${appPassword}' NOBYPASSRLS`);
    await client.query(`GRANT CONNECT ON DATABASE keepsake TO ${appRole}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);
    await client.query(`GRANT USAGE ON TYPE channel_provider, channel_account_status TO ${appRole}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON channel_accounts TO ${appRole}`);
    await client.query(`GRANT EXECUTE ON FUNCTION current_user_id() TO ${appRole}`);
  });

  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const encryptionKey = randomBytes(32).toString("base64");

  await withClient(adminUrl, async (client) => {
    await client.query(
      `INSERT INTO users (id, email, display_name)
       VALUES ($1, 'owner-a@example.test', 'Owner A'),
              ($2, 'owner-b@example.test', 'Owner B')`,
      [ownerA, ownerB],
    );
  });

  // App pool = NOBYPASSRLS for request paths. Worker pool = admin (BYPASSRLS)
  // for findByProviderUser and link's cross-owner enforcement.
  process.env.DATABASE_URL = appUrl;
  process.env.KEEPSAKE_WORKER_DATABASE_URL = adminUrl;
  process.env.DEV_ENCRYPTION_KEY_BASE64 = encryptionKey;
  const { db, decrypt, repo } = await loadRepository();

  process.stdout.write("verifying ChannelAccountRepository:\n");

  // ── listForOwner starts empty ─────────────────────────────────────
  assertEqual((await repo.listForOwner(ownerA)).length, 0, "owner A starts with no channels");
  assertEqual((await repo.listForOwner(ownerB)).length, 0, "owner B starts with no channels");

  // ── link: first WhatsApp identity for owner A ─────────────────────
  const linked = await repo.link(ownerA, {
    provider: "whatsapp",
    externalUserId: "wa-1",
    externalThreadId: null,
    displayName: "Alice Phone",
    rawProfile: { locale: "en-SG" },
  });
  assert(/^[0-9a-f-]{36}$/i.test(linked.id), "link returns a uuid id");
  assertEqual(linked.ownerId, ownerA, "link returns ownerA");
  assertEqual(linked.provider, "whatsapp", "link returns provider");
  assertEqual(linked.externalUserId, "wa-1", "link returns externalUserId");
  assertEqual(linked.status, "active", "link starts active");
  assertEqual(linked.displayName, "Alice Phone", "link returns decrypted displayName");
  assertEqual(linked.rawProfile?.locale, "en-SG", "link round-trips rawProfile");

  // ── listForOwner sees it; cross-owner does not ─────────────────────
  const listA = await repo.listForOwner(ownerA);
  assertEqual(listA.length, 1, "owner A sees 1 channel after link");
  assertEqual(listA[0].id, linked.id, "owner A list returns the linked id");
  assertEqual(listA[0].displayName, "Alice Phone", "listForOwner decrypts displayName");
  assertEqual((await repo.listForOwner(ownerB)).length, 0, "owner B still sees 0");

  // ── findByProviderUser must require an explicit (worker) tx ───────
  await expectReject(
    () => repo.findByProviderUser("whatsapp", "wa-1"),
    /worker \/ webhook tx/i,
    "findByProviderUser without tx throws",
  );

  // ── findByProviderUser inside a workerTransaction returns the row ─
  const found = await db.workerTransaction(async (tx) =>
    repo.findByProviderUser("whatsapp", "wa-1", tx),
  );
  assert(found !== null, "findByProviderUser returns the linked row");
  assertEqual(found.id, linked.id, "findByProviderUser id matches");
  assertEqual(found.ownerId, ownerA, "findByProviderUser owner is A");
  assertEqual(found.displayName, "Alice Phone", "findByProviderUser decrypts displayName");

  // ── findByProviderUser unknown identity → null ────────────────────
  const missing = await db.workerTransaction(async (tx) =>
    repo.findByProviderUser("whatsapp", "wa-does-not-exist", tx),
  );
  assertEqual(missing, null, "findByProviderUser unknown returns null");

  // ── re-link same owner: idempotent on id, updates fields ─────────
  const relinked = await repo.link(ownerA, {
    provider: "whatsapp",
    externalUserId: "wa-1",
    externalThreadId: "thread-7",
    displayName: "Alice (updated)",
    rawProfile: { locale: "en-US", tz: "America/Los_Angeles" },
  });
  assertEqual(relinked.id, linked.id, "re-link preserves id");
  assertEqual(relinked.status, "active", "re-link keeps status active");
  assertEqual(relinked.externalThreadId, "thread-7", "re-link refreshes externalThreadId");
  assertEqual(relinked.displayName, "Alice (updated)", "re-link refreshes displayName");
  assertEqual(relinked.rawProfile?.tz, "America/Los_Angeles", "re-link refreshes rawProfile");

  // ── encryption: raw display_name_enc must NOT contain the plaintext
  const raw = await rawRow(adminUrl, linked.id);
  assert(raw.display_name_enc instanceof Buffer || raw.display_name_enc instanceof Uint8Array,
    "display_name_enc stored as bytea");
  const rawBytes = Buffer.from(raw.display_name_enc);
  assert(!rawBytes.toString("utf8").includes("Alice"),
    "display_name_enc never holds plaintext 'Alice'");
  assert(!rawBytes.toString("utf8").includes("updated"),
    "display_name_enc never holds plaintext 'updated'");
  const decryptedBytes = Buffer.from(
    await decrypt(ownerA, "channel_accounts", "display_name_enc", rawBytes),
  ).toString("utf8");
  assertEqual(decryptedBytes, "Alice (updated)",
    "display_name_enc decrypts with channel_accounts AAD");
  assertEqual(raw.external_user_id, "wa-1",
    "external_user_id stored as plaintext (lookup key)");
  assertEqual(raw.raw_profile?.tz, "America/Los_Angeles",
    "raw_profile stored as jsonb round-trip");

  // ── displayName=null clears the encrypted column ─────────────────
  const noName = await repo.link(ownerA, {
    provider: "telegram",
    externalUserId: "tg-9",
    displayName: null,
  });
  assertEqual(noName.displayName, null, "displayName null → null on read");
  const noNameRaw = await rawRow(adminUrl, noName.id);
  assertEqual(noNameRaw.display_name_enc, null, "displayName null → display_name_enc NULL");

  // ── markRevoked flips status, list still includes it ─────────────
  await repo.markRevoked(ownerA, linked.id);
  const afterRevoke = await repo.listForOwner(ownerA);
  const revokedRow = afterRevoke.find((r) => r.id === linked.id);
  assertEqual(revokedRow?.status, "revoked", "markRevoked sets status revoked");
  assertEqual(
    afterRevoke.filter((r) => r.id === linked.id).length, 1,
    "revoked row stays in listForOwner",
  );

  // ── re-link AFTER revoke flips status back to active ─────────────
  const reactivated = await repo.link(ownerA, {
    provider: "whatsapp",
    externalUserId: "wa-1",
    displayName: "Alice reconnected",
  });
  assertEqual(reactivated.id, linked.id, "re-link after revoke keeps id");
  assertEqual(reactivated.status, "active", "re-link after revoke flips back to active");

  // ── markRevoked cross-owner / unknown → throws not-found ─────────
  await expectReject(
    () => repo.markRevoked(ownerB, linked.id),
    /not found/i,
    "markRevoked cross-owner throws not-found",
  );
  await expectReject(
    () => repo.markRevoked(ownerA, "00000000-0000-4000-8000-000000000000"),
    /not found/i,
    "markRevoked unknown id throws not-found",
  );

  // ── cross-owner link attempt for same (provider, externalUserId) ──
  await expectReject(
    () => repo.link(ownerB, {
      provider: "whatsapp",
      externalUserId: "wa-1",
      displayName: "Mallory",
    }),
    /cross_owner_conflict/i,
    "cross-owner link throws cross_owner_conflict",
  );
  // The original row must be untouched: still owned by A, displayName
  // not poisoned with Mallory's encrypted ciphertext.
  const stillOwnerA = await db.workerTransaction(async (tx) =>
    repo.findByProviderUser("whatsapp", "wa-1", tx),
  );
  assertEqual(stillOwnerA.ownerId, ownerA, "cross-owner link did NOT rebind owner_id");
  assertEqual(stillOwnerA.displayName, "Alice reconnected",
    "cross-owner link did NOT overwrite displayName");

  // ── transaction-reuse path: caller passes explicit owner-scoped tx
  const reused = await db.transaction(ownerA, async (tx) => {
    return repo.listForOwner(ownerA, tx);
  });
  assert(reused.length >= 2, "explicit Tx reuse: listForOwner sees A's links");

  process.stdout.write("\nall channel-accounts repository checks passed\n");
} catch (error) {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  if (error?.stack) process.stderr.write(error.stack + "\n");
  process.exitCode = 1;
} finally {
  await helperClose().catch(() => {});
  await helperCleanup().catch(() => {});
  if (containerStarted) {
    await docker(["stop", containerName]).catch((error) => {
      process.stderr.write(`failed to stop ${containerName}: ${error.message}\n`);
    });
  }
}
