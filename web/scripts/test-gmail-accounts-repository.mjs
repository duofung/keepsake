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
const containerName = `keepsake-test-gmail-accounts-${Date.now()}`;
const postgresImage = "postgres:17-alpine";
const appRole = "keepsake_app";
const appPassword = "keepsake_app";

let containerStarted = false;
let helperClose = async () => {};
let helperCleanup = async () => {};

function command(commandName, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(
          `${commandName} ${args.join(" ")} failed with exit code ${code}\n${stderr || stdout}`,
        ));
      }
    });
  });
}

async function docker(args) {
  return command("docker", args);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  throw new Error(`Postgres did not become ready: ${lastError?.message ?? "unknown error"}`);
}

async function withClient(databaseUrl, fn) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
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
  const tempRoot = join(projectRoot, ".next", "test-gmail-accounts-repository");
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, "run-"));
  helperCleanup = () => rm(tempDir, { force: true, recursive: true });

  const transactionSourcePath = join(projectRoot, "lib/server/db/transaction.server.ts");
  const transactionSource = (await readFile(transactionSourcePath, "utf8"))
    .replace(/^import "server-only";\n/, "")
    .concat(`
export async function __closePoolForTest() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
`);
  const transactionOutputPath = join(tempDir, "transaction.server.cjs");
  await writeFile(transactionOutputPath, transpile(transactionSourcePath, transactionSource));

  const envelopeSourcePath = join(projectRoot, "lib/server/crypto/envelope.server.ts");
  const envelopeSource = (await readFile(envelopeSourcePath, "utf8"))
    .replace(/^import "server-only";\n/, "");
  const envelopeOutputPath = join(tempDir, "envelope.server.cjs");
  await writeFile(envelopeOutputPath, transpile(envelopeSourcePath, envelopeSource));

  const gmailSourcePath = join(projectRoot, "lib/repositories/gmail-accounts.server.ts");
  const gmailSource = (await readFile(gmailSourcePath, "utf8"))
    .replace(/^import "server-only";\n/, "")
    .replace(
      /from "@\/lib\/server\/db\/transaction\.server"/g,
      'from "./transaction.server.cjs"',
    )
    .replace(
      /from "@\/lib\/server\/crypto\/envelope\.server"/g,
      'from "./envelope.server.cjs"',
    );
  const gmailOutputPath = join(tempDir, "gmail-accounts.server.cjs");
  await writeFile(gmailOutputPath, transpile(gmailSourcePath, gmailSource));

  const require = createRequire(import.meta.url);
  const db = require(transactionOutputPath);
  const envelope = require(envelopeOutputPath);
  const gmailModule = require(gmailOutputPath);

  if (typeof db.transaction !== "function" || typeof db.query !== "function") {
    throw new Error("transaction.server.ts did not expose transaction() and query().");
  }
  if (typeof db.__closePoolForTest !== "function") {
    throw new Error("test harness could not attach a pool cleanup hook.");
  }
  if (typeof envelope.decrypt !== "function") {
    throw new Error("envelope.server.ts did not expose decrypt().");
  }
  if (typeof gmailModule.createGmailAccountRepository !== "function") {
    throw new Error("gmail-accounts.server.ts did not export createGmailAccountRepository().");
  }

  helperClose = db.__closePoolForTest;
  return {
    db,
    decrypt: envelope.decrypt,
    gmailAccounts: gmailModule.createGmailAccountRepository(),
  };
}

function assert(condition, label, detail = "") {
  if (!condition) {
    throw new Error(`${label}${detail ? `: ${detail}` : ""}`);
  }
  process.stdout.write(`  ✓ ${label}\n`);
}

function assertEqual(actual, expected, label) {
  assert(actual === expected, label, `expected ${expected}, got ${actual}`);
}

async function expectReject(fn, label) {
  try {
    await fn();
  } catch {
    process.stdout.write(`  ✓ ${label}\n`);
    return;
  }

  throw new Error(`${label}: expected rejection`);
}

async function decryptRefreshToken(decrypt, ownerId, envelope) {
  return Buffer.from(
    await decrypt(ownerId, "gmail_accounts", "refresh_token_enc", envelope),
  ).toString("utf8");
}

async function rawAccount(databaseUrl, accountId) {
  return withClient(databaseUrl, async (client) => {
    const result = await client.query(
      `
        SELECT
          id::text,
          owner_id::text,
          email::text,
          is_primary,
          status,
          refresh_token_enc,
          length(last_error) AS last_error_length
        FROM gmail_accounts
        WHERE id = $1
      `,
      [accountId],
    );
    return result.rows[0];
  });
}

async function ownerRows(databaseUrl, ownerId) {
  return withClient(databaseUrl, async (client) => {
    const result = await client.query(
      `
        SELECT email::text, is_primary, status
        FROM gmail_accounts
        WHERE owner_id = $1
        ORDER BY email
      `,
      [ownerId],
    );
    return result.rows;
  });
}

try {
  process.stdout.write("checking Docker availability:\n");
  await docker(["--version"]);
  process.stdout.write("  ✓ docker CLI is available\n");

  process.stdout.write(`starting ${postgresImage}:\n`);
  await docker([
    "run",
    "--rm",
    "-d",
    "--name",
    containerName,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-e",
    "POSTGRES_DB=keepsake",
    "-p",
    "127.0.0.1::5432",
    postgresImage,
  ]);
  containerStarted = true;

  const portOutput = await docker(["port", containerName, "5432/tcp"]);
  const port = portOutput.stdout.trim().split(":").pop();
  const adminUrl = `postgres://postgres:postgres@127.0.0.1:${port}/keepsake`;
  const appUrl = `postgres://${appRole}:${appPassword}@127.0.0.1:${port}/keepsake`;

  await waitForPostgres(adminUrl);
  process.stdout.write("  ✓ postgres is accepting connections\n");

  process.stdout.write("loading schema:\n");
  await runSqlFile(adminUrl, "db/schema.sql");

  await withClient(adminUrl, async (client) => {
    await client.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${appPassword}' NOBYPASSRLS`);
    await client.query(`GRANT CONNECT ON DATABASE keepsake TO ${appRole}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);
    await client.query(`GRANT USAGE ON TYPE gmail_account_status TO ${appRole}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON gmail_accounts TO ${appRole}`);
    await client.query(`GRANT EXECUTE ON FUNCTION current_user_id() TO ${appRole}`);
  });

  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  const encryptionKey = randomBytes(32).toString("base64");

  await withClient(adminUrl, async (client) => {
    await client.query(
      `
        INSERT INTO users (id, email, display_name)
        VALUES
          ($1, 'gmail-owner@example.test', 'Gmail Owner'),
          ($2, 'other-gmail-owner@example.test', 'Other Gmail Owner')
      `,
      [ownerId, otherOwnerId],
    );
  });

  process.env.DATABASE_URL = appUrl;
  process.env.DEV_ENCRYPTION_KEY_BASE64 = encryptionKey;
  const { db, decrypt, gmailAccounts } = await loadRepository();

  process.stdout.write("verifying GmailAccountRepository:\n");

  assert(await gmailAccounts.getPrimary(ownerId) === null, "getPrimary starts null");

  const first = await gmailAccounts.upsertPrimary(ownerId, {
    email: "sender@example.test",
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
    refreshToken: "refresh-token-one",
    refreshTokenExpiresAtISO: "2026-07-01T00:00:00.000Z",
  });

  assert(/^[0-9a-f-]{36}$/i.test(first.id), "upsertPrimary returns DB uuid id");
  assertEqual(first.ownerId, ownerId, "upsertPrimary maps ownerId");
  assertEqual(first.email, "sender@example.test", "upsertPrimary maps email");
  assertEqual(first.status, "connected", "upsertPrimary status connected");
  assertEqual(first.scopes[0], "https://www.googleapis.com/auth/gmail.send", "upsertPrimary maps scopes");
  assertEqual(first.isPrimary, true, "upsertPrimary marks primary");
  assertEqual(first.refreshTokenExpiresAtISO, "2026-07-01T00:00:00.000Z", "upsertPrimary maps token expiry");
  assertEqual(first.lastError, null, "upsertPrimary clears lastError");
  assert(!("refreshToken" in first), "read model never exposes refreshToken");

  const primary = await gmailAccounts.getPrimary(ownerId);
  assertEqual(primary?.id, first.id, "getPrimary returns primary account");

  const rawFirst = await rawAccount(adminUrl, first.id);
  assert(rawFirst.refresh_token_enc instanceof Buffer, "raw refresh_token_enc is bytea");
  assert(!rawFirst.refresh_token_enc.toString("utf8").includes("refresh-token-one"), "refresh_token_enc stores ciphertext");
  assertEqual(
    await decryptRefreshToken(decrypt, ownerId, rawFirst.refresh_token_enc),
    "refresh-token-one",
    "refresh_token_enc decrypts with gmail_accounts AAD",
  );

  assert(await gmailAccounts.getPrimary(otherOwnerId) === null, "other owner sees no primary");
  await expectReject(
    () => gmailAccounts.markExpired(otherOwnerId, first.id, { lastError: "hidden" }),
    "other owner cannot mark account expired",
  );

  const longError = "x".repeat(3000);
  const expired = await gmailAccounts.markExpired(ownerId, first.id, { lastError: longError });
  assertEqual(expired.status, "expired", "markExpired sets status expired");
  assertEqual(expired.lastError?.length, 2048, "markExpired clips lastError");
  assertEqual((await rawAccount(adminUrl, first.id)).last_error_length, 2048, "last_error stored clipped");

  const reconnected = await gmailAccounts.upsertPrimary(ownerId, {
    email: "sender@example.test",
    scopes: [
      "https://www.googleapis.com/auth/gmail.send",
      "openid",
    ],
    refreshToken: "refresh-token-two",
  });
  assertEqual(reconnected.id, first.id, "upsertPrimary updates existing account by owner/email");
  assertEqual(reconnected.status, "connected", "upsertPrimary reconnects expired account");
  assertEqual(reconnected.lastError, null, "upsertPrimary clears expired error");
  assertEqual(reconnected.scopes.length, 2, "upsertPrimary updates scopes");
  assertEqual(
    await decryptRefreshToken(decrypt, ownerId, (await rawAccount(adminUrl, first.id)).refresh_token_enc),
    "refresh-token-two",
    "upsertPrimary rotates refresh token ciphertext",
  );

  const second = await gmailAccounts.upsertPrimary(ownerId, {
    email: "second-sender@example.test",
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
    refreshToken: "refresh-token-three",
  });
  assert(second.id !== first.id, "upsertPrimary creates a second account for a new email");
  assertEqual((await gmailAccounts.getPrimary(ownerId))?.id, second.id, "getPrimary returns newest primary");

  const rowsAfterSecond = await ownerRows(adminUrl, ownerId);
  assertEqual(rowsAfterSecond.length, 2, "owner has two Gmail account rows");
  assertEqual(rowsAfterSecond.filter((row) => row.is_primary).length, 1, "only one primary row exists");
  assertEqual(rowsAfterSecond.find((row) => row.email === "sender@example.test")?.is_primary, false, "old sender demoted");
  assertEqual(rowsAfterSecond.find((row) => row.email === "second-sender@example.test")?.is_primary, true, "new sender promoted");

  await gmailAccounts.disconnect(otherOwnerId, second.id);
  assertEqual((await gmailAccounts.getPrimary(ownerId))?.id, second.id, "other owner disconnect cannot delete account");

  await db.transaction(ownerId, async (tx) => {
    const txAccount = await gmailAccounts.upsertPrimary(ownerId, {
      email: "tx-sender@example.test",
      scopes: ["https://www.googleapis.com/auth/gmail.send"],
      refreshToken: "refresh-token-tx",
    }, tx);
    const txPrimary = await gmailAccounts.getPrimary(ownerId, tx);
    assertEqual(txPrimary?.id, txAccount.id, "explicit Tx reuse sees uncommitted primary");
  });

  const committedTxPrimary = await gmailAccounts.getPrimary(ownerId);
  assertEqual(committedTxPrimary?.email, "tx-sender@example.test", "explicit Tx primary committed");

  await gmailAccounts.disconnect(ownerId, committedTxPrimary.id);
  assert(await gmailAccounts.getPrimary(ownerId) === null, "disconnect removes primary account");

  process.stdout.write("\nall Gmail account repository checks passed\n");
} catch (error) {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
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
