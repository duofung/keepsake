// DB-backed smoke for POST /api/channels/mock/inbound (P8-D).
//
// Boots throwaway Postgres, links mock provider identities through the
// ChannelAccountRepository, starts Next in KEEPSAKE_DATA_SOURCE=db mode, and
// proves provider identity is the only auth input. No web session, no
// DEV_OWNER fallback, no draft/send side effects.

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, normalize, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = normalize(join(__dirname, ".."));
const containerName = `keepsake-test-channels-inbound-${Date.now()}`;
const postgresImage = "postgres:17-alpine";
const appRole = "keepsake_app";
const appPassword = "keepsake_app";
const port = Number(process.env.TEST_CHANNELS_INBOUND_DB_PORT ?? 3221);
const base = `http://localhost:${port}`;

let containerStarted = false;
let nextChild = null;
let helperClose = async () => {};
let helperCleanup = async () => {};

function command(commandName, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(commandName, args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${commandName} ${args.join(" ")} failed: ${stderr || stdout}`));
    });
  });
}

async function docker(args) {
  return command("docker", args);
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
      await wait(500);
    }
  }
  throw new Error(`Postgres did not become ready: ${lastError?.message ?? "unknown"}`);
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

async function loadChannelAccountRepository() {
  const tempRoot = join(projectRoot, ".next", "test-channels-inbound");
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

  const envelopeSrcPath = join(projectRoot, "lib/server/crypto/envelope.server.ts");
  const envelopeSrc = (await readFile(envelopeSrcPath, "utf8"))
    .replace(/^import "server-only";\n/, "");
  const envelopeOut = join(tempDir, "envelope.server.cjs");
  await writeFile(envelopeOut, transpile(envelopeSrcPath, envelopeSrc));

  const repoSrcPath = join(projectRoot, "lib/repositories/channel-accounts.server.ts");
  const repoSrc = (await readFile(repoSrcPath, "utf8"))
    .replace(/^import "server-only";\n/, "")
    .replace(/from "@\/lib\/server\/db\/transaction\.server"/g, 'from "./transaction.server.cjs"')
    .replace(/from "@\/lib\/server\/crypto\/envelope\.server"/g, 'from "./envelope.server.cjs"');
  const repoOut = join(tempDir, "channel-accounts.server.cjs");
  await writeFile(repoOut, transpile(repoSrcPath, repoSrc));

  const require = createRequire(import.meta.url);
  const db = require(txOut);
  const mod = require(repoOut);

  if (typeof db.__closePoolForTest !== "function") {
    throw new Error("pool cleanup hook missing");
  }
  if (typeof mod.createChannelAccountRepository !== "function") {
    throw new Error("createChannelAccountRepository export missing");
  }

  helperClose = db.__closePoolForTest;
  return mod.createChannelAccountRepository();
}

async function waitForNext() {
  const deadline = Date.now() + 60_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await postInbound({});
      if (res.status < 500) return;
      lastError = new Error(`status=${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(500);
  }
  throw new Error(`Next dev did not become ready: ${lastError?.message ?? "unknown"}`);
}

async function stopNext() {
  if (!nextChild) return;
  const child = nextChild;
  nextChild = null;
  if (child.exitCode !== null || child.signalCode !== null) return;

  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
    wait(3_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

async function postInbound(body) {
  const res = await fetch(`${base}/api/channels/mock/inbound`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, body: json };
}

const failures = [];
function check(name, condition, detail = "") {
  if (condition) process.stdout.write(`  ✓ ${name}\n`);
  else {
    process.stdout.write(`  ✗ ${name}${detail ? `  (${detail})` : ""}\n`);
    failures.push(name);
  }
}

try {
  process.stdout.write("checking Docker availability:\n");
  await docker(["--version"]);
  process.stdout.write("  ✓ docker CLI is available\n");

  process.stdout.write(`starting ${postgresImage}:\n`);
  await docker([
    "run", "--rm", "-d",
    "--name", containerName,
    "-e", "POSTGRES_PASSWORD=postgres",
    "-e", "POSTGRES_DB=keepsake",
    "-p", "127.0.0.1::5432",
    postgresImage,
  ]);
  containerStarted = true;

  const portOutput = await docker(["port", containerName, "5432/tcp"]);
  const pgPort = portOutput.stdout.trim().split(":").pop();
  const adminUrl = `postgres://postgres:postgres@127.0.0.1:${pgPort}/keepsake`;
  const appUrl = `postgres://${appRole}:${appPassword}@127.0.0.1:${pgPort}/keepsake`;

  await waitForPostgres(adminUrl);
  process.stdout.write("  ✓ postgres is accepting connections\n");

  process.stdout.write("loading schema + catalog seed:\n");
  await runSqlFile(adminUrl, "db/schema.sql");
  await runSqlFile(adminUrl, "db/seed_catalog.sql");

  await withClient(adminUrl, async (client) => {
    await client.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${appPassword}' NOBYPASSRLS`);
    await client.query(`GRANT CONNECT ON DATABASE keepsake TO ${appRole}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);
    // Enums referenced by the queries P8-E touches (channel_accounts,
    // people, occasion_nodes, relationships).
    await client.query(`
      GRANT USAGE ON TYPE
        channel_provider,
        channel_account_status,
        relationship_kind,
        relationship_group,
        occasion_kind,
        tone,
        channel
      TO ${appRole}
    `);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON channel_accounts TO ${appRole}`);
    // P8-E read path: handleOwnerCommand opens a transaction(ownerId, …)
    // and calls PeopleRepository.listWithRelations, which selects from
    // people + occasion_nodes + relationships + cultures.
    await client.query(`GRANT SELECT ON people, occasion_nodes, relationships, cultures TO ${appRole}`);
    await client.query(`GRANT EXECUTE ON FUNCTION current_user_id() TO ${appRole}`);
  });

  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const encryptionKey = randomBytes(32).toString("base64");

  await withClient(adminUrl, async (client) => {
    await client.query(
      `INSERT INTO users (id, email, display_name)
       VALUES ($1, 'channel-owner-a@example.test', 'Channel Owner A'),
              ($2, 'channel-owner-b@example.test', 'Channel Owner B')`,
      [ownerA, ownerB],
    );
  });

  process.env.DATABASE_URL = appUrl;
  process.env.KEEPSAKE_WORKER_DATABASE_URL = adminUrl;
  process.env.DEV_ENCRYPTION_KEY_BASE64 = encryptionKey;

  // P8-E seeds: give ownerA the standard dev fixtures (people +
  // occasions, encrypted) via the project's seed script. ownerB stays
  // empty so cross-owner isolation can be asserted by emptiness.
  process.stdout.write("seeding dev fixtures for ownerA:\n");
  await command("node", ["scripts/seed-dev-fixtures.mjs"], {
    env: {
      ...process.env,
      DATABASE_URL: adminUrl,
      DEV_ENCRYPTION_KEY_BASE64: encryptionKey,
      DEV_OWNER_ID: ownerA,
      DEV_OWNER_EMAIL: "channel-owner-a@example.test",
      DEV_OWNER_NAME: "Channel Owner A",
    },
  });
  process.stdout.write("  ✓ ownerA fixtures seeded\n");

  const repo = await loadChannelAccountRepository();
  await repo.link(ownerA, {
    provider: "mock",
    externalUserId: "mock-user-1",
    externalThreadId: "thread-active",
    displayName: "Mock Active",
    rawProfile: { source: "test" },
  });
  // mock-user-b → ownerB. ownerB has NO seeded people/occasions, so a
  // follow-up query through this channel must come back with the
  // empty-window response and must not mention any of ownerA's
  // fixture names.
  await repo.link(ownerB, {
    provider: "mock",
    externalUserId: "mock-user-b",
    externalThreadId: "thread-b",
    displayName: "Mock Owner B",
  });
  const revoked = await repo.link(ownerA, {
    provider: "mock",
    externalUserId: "mock-revoked",
    externalThreadId: "thread-revoked",
    displayName: "Mock Revoked",
  });
  await repo.markRevoked(ownerA, revoked.id);
  process.stdout.write("  ✓ linked active + revoked mock channel accounts\n");

  const nextBin = resolve(projectRoot, "node_modules/.bin/next");
  nextChild = spawn(nextBin, ["dev", "--port", String(port)], {
    cwd: projectRoot,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      BROWSER: "none",
      DATABASE_URL: appUrl,
      KEEPSAKE_WORKER_DATABASE_URL: adminUrl,
      DEV_ENCRYPTION_KEY_BASE64: encryptionKey,
      DEV_OWNER_ID: ownerB,
      DEV_OWNER_EMAIL: "fallback-owner@example.test",
      DEV_OWNER_NAME: "Fallback Owner",
      KEEPSAKE_DATA_SOURCE: "db",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });
  let serverError = "";
  nextChild.stderr.on("data", (chunk) => { serverError += chunk.toString(); });

  process.stdout.write(`booting next dev on :${port}...\n`);
  await waitForNext();
  process.stdout.write("server ready, running assertions:\n");

  {
    const res = await postInbound("{not json");
    check("malformed JSON -> 400",
      res.status === 400 && res.body?.code === "invalid_request",
      `status=${res.status} body=${JSON.stringify(res.body)}`);
  }
  {
    const res = await postInbound({ externalUserId: "mock-user-1" });
    check("missing text -> 400",
      res.status === 400 && res.body?.code === "invalid_request"
        && res.body?.detail === "text is required",
      `status=${res.status} body=${JSON.stringify(res.body)}`);
  }
  {
    const res = await postInbound({ text: "最近有什么需要跟进的关系吗？" });
    check("missing externalUserId -> 400",
      res.status === 400 && res.body?.code === "invalid_request"
        && res.body?.detail === "externalUserId is required",
      `status=${res.status} body=${JSON.stringify(res.body)}`);
  }

  {
    const res = await postInbound({
      externalUserId: "not-linked-even-with-dev-owner",
      text: "最近有什么需要跟进的关系吗？",
    });
    check("unlinked externalUserId -> 200",
      res.status === 200, `status=${res.status}`);
    check("unlinked status = needs_link",
      res.body?.status === "needs_link" && res.body?.code === "needs_link",
      JSON.stringify(res.body));
    check("unlinked has no suggestedAction",
      res.body?.suggestedAction === undefined,
      JSON.stringify(res.body));
    check("unlinked did NOT fall back to DEV_OWNER",
      res.body?.ownerId === undefined && res.body?.intent === "unknown",
      JSON.stringify(res.body));
  }

  // P8-E happy path: ownerA's follow-up reply must reflect that owner's
  // seeded people/occasions — name + occasion label of someone in the
  // 30-day window.
  const ownerAFixtureNames = ["Lin", "Mom", "Aisha", "Dad", "Kira"];
  const ownerAOccasionLabels = ["Anniversary", "Birthday", "Hari Raya"];
  let ownerAFollowUpText = "";
  {
    const res = await postInbound({
      externalUserId: "mock-user-1",
      externalThreadId: "thread-active",
      text: "最近有什么需要跟进的关系吗？",
      raw: { fixture: "follow-up" },
    });
    check("active follow-up -> 200", res.status === 200);
    check("active follow-up status=ok",
      res.body?.status === "ok", JSON.stringify(res.body));
    check("active follow-up intent",
      res.body?.intent === "relationship_followup_query",
      JSON.stringify(res.body));
    check("active follow-up suggestedAction",
      res.body?.suggestedAction?.kind === "open_relationship_followups",
      JSON.stringify(res.body));
    check("active follow-up echoes ownerId for mock smoke only",
      res.body?.ownerId === ownerA,
      JSON.stringify(res.body));

    ownerAFollowUpText = typeof res.body?.text === "string" ? res.body.text : "";
    const namesHit = ownerAFixtureNames.filter((name) =>
      ownerAFollowUpText.includes(name),
    );
    check(
      "active follow-up text names at least one real fixture person",
      namesHit.length >= 1,
      `text=${ownerAFollowUpText}`,
    );
    const labelHit = ownerAOccasionLabels.some((label) =>
      ownerAFollowUpText.includes(label),
    );
    check(
      "active follow-up text mentions a real occasion label",
      labelHit, `text=${ownerAFollowUpText}`,
    );
    check(
      "active follow-up text still points the user back to Keepsake to act",
      /open\s+keepsake/i.test(ownerAFollowUpText),
      `text=${ownerAFollowUpText}`,
    );
    check(
      "active follow-up text does NOT claim execution",
      !/\b(sent|delivered|queued)\b/i.test(ownerAFollowUpText),
      `text=${ownerAFollowUpText}`,
    );
  }

  // P8-E cross-owner isolation: a different linked owner with no
  // seeded people/occasions must see the empty-window message and
  // MUST NOT see any of ownerA's fixture names.
  {
    const res = await postInbound({
      externalUserId: "mock-user-b",
      text: "最近有什么需要跟进的关系吗？",
    });
    check("ownerB follow-up -> 200", res.status === 200);
    check("ownerB follow-up status=ok",
      res.body?.status === "ok", JSON.stringify(res.body));
    check("ownerB follow-up intent",
      res.body?.intent === "relationship_followup_query",
      JSON.stringify(res.body));
    check("ownerB follow-up echoes ownerId=B (NOT ownerA)",
      res.body?.ownerId === ownerB && res.body?.ownerId !== ownerA,
      JSON.stringify(res.body));

    const ownerBText = typeof res.body?.text === "string" ? res.body.text : "";
    const leakedName = ownerAFixtureNames.find((name) =>
      ownerBText.includes(name),
    );
    check(
      "ownerB follow-up text does NOT leak ownerA fixture names",
      leakedName === undefined,
      `leaked=${leakedName ?? ""} text=${ownerBText}`,
    );
    check(
      "ownerB follow-up text uses the empty-window response",
      /nothing\s+in\s+the\s+next/i.test(ownerBText),
      `text=${ownerBText}`,
    );
  }

  {
    const res = await postInbound({
      externalUserId: "mock-user-1",
      text: "帮我给 Helen 发一个邮件，她今天升职了，我要祝福她",
    });
    check("active compose -> 200", res.status === 200);
    check("active compose status=needs_review",
      res.body?.status === "needs_review",
      JSON.stringify(res.body));
    check("active compose intent",
      res.body?.intent === "compose_request",
      JSON.stringify(res.body));
    check("active compose suggestedAction.kind",
      res.body?.suggestedAction?.kind === "open_compose_workspace",
      JSON.stringify(res.body));
    check("active compose recipientHint=Helen",
      res.body?.suggestedAction?.recipientHint === "Helen",
      JSON.stringify(res.body));
    const bodyText = JSON.stringify(res.body).toLowerCase();
    check("active compose response does NOT claim execution",
      !/\b(sent|delivered|queued)\b/.test(bodyText),
      bodyText);
  }

  {
    const res = await postInbound({
      externalUserId: "mock-revoked",
      text: "Send Helen an email — she got promoted today",
    });
    check("revoked externalUserId -> 200",
      res.status === 200, `status=${res.status}`);
    check("revoked status = needs_link",
      res.body?.status === "needs_link" && res.body?.code === "needs_link",
      JSON.stringify(res.body));
    check("revoked has no suggestedAction",
      res.body?.suggestedAction === undefined,
      JSON.stringify(res.body));
  }
} catch (error) {
  process.stdout.write(`harness error: ${error?.message ?? error}\n`);
  failures.push("harness");
} finally {
  await stopNext();
  await helperClose().catch(() => {});
  await helperCleanup().catch(() => {});
  if (containerStarted) {
    await docker(["stop", containerName]).catch((error) => {
      process.stderr.write(`failed to stop ${containerName}: ${error.message}\n`);
    });
  }
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall /api/channels/mock/inbound DB checks passed\n");
  process.exit(0);
}
