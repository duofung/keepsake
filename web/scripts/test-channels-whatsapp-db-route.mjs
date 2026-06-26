// DB-backed smoke for POST /api/channels/whatsapp (P11-A).
//
// Boots throwaway Postgres, seeds WhatsApp channel identities, starts Next in
// KEEPSAKE_DATA_SOURCE=db mode, and verifies the WhatsApp webhook foundation
// resolves provider identity before delegating to the shared review-first
// command path. No outbound WhatsApp calls, no web session, no draft/send
// effects.

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = normalize(join(__dirname, ".."));
const containerName = `keepsake-test-channels-whatsapp-${Date.now()}`;
const postgresImage = "postgres:17-alpine";
const appRole = "keepsake_app";
const appPassword = "keepsake_app";
const port = Number(process.env.TEST_CHANNELS_WHATSAPP_DB_PORT ?? 3226);
const base = `http://localhost:${port}`;
const whatsappSecret = "whatsapp-secret-token-test";

let containerStarted = false;
let nextChild = null;

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

async function waitForNext() {
  const deadline = Date.now() + 60_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await postWhatsApp("{not json");
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

async function postWhatsApp(body, { secret = whatsappSecret } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret !== null) headers["x-whatsapp-webhook-secret"] = secret;
  const res = await fetch(`${base}/api/channels/whatsapp`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, body: json };
}

function whatsappText({
  from,
  text,
  phoneNumberId = "phone-number-1",
  timestamp = "1782000000",
}) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-1",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: {
            display_phone_number: "15550000000",
            phone_number_id: phoneNumberId,
          },
          contacts: [{
            wa_id: from,
            profile: { name: "WhatsApp Contact" },
          }],
          messages: [{
            from,
            id: `wamid.${from}`,
            timestamp,
            type: "text",
            text: { body: text },
          }],
        },
      }],
    }],
  };
}

function whatsappImage({ from, phoneNumberId = "phone-number-1" }) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-1",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { phone_number_id: phoneNumberId },
          messages: [{
            from,
            id: `wamid.image.${from}`,
            timestamp: "1782000000",
            type: "image",
            image: { id: "image-1" },
          }],
        },
      }],
    }],
  };
}

const failures = [];
function check(name, condition, detail = "") {
  if (condition) process.stdout.write(`  ✓ ${name}\n`);
  else {
    process.stdout.write(`  ✗ ${name}${detail ? `  (${detail})` : ""}\n`);
    failures.push(name);
  }
}

function noExecutionClaim(value) {
  return !/\b(sent|delivered|queued)\b/i.test(JSON.stringify(value));
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
    await client.query(`GRANT SELECT ON channel_accounts TO ${appRole}`);
    await client.query(`GRANT SELECT ON people, occasion_nodes, relationships, cultures TO ${appRole}`);
    await client.query(`GRANT EXECUTE ON FUNCTION current_user_id() TO ${appRole}`);
  });

  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const encryptionKey = randomBytes(32).toString("base64");

  await withClient(adminUrl, async (client) => {
    await client.query(
      `INSERT INTO users (id, email, display_name)
       VALUES ($1, 'whatsapp-owner-a@example.test', 'WhatsApp Owner A'),
              ($2, 'whatsapp-owner-b@example.test', 'WhatsApp Owner B')`,
      [ownerA, ownerB],
    );
  });

  process.env.DATABASE_URL = appUrl;
  process.env.KEEPSAKE_WORKER_DATABASE_URL = adminUrl;
  process.env.DEV_ENCRYPTION_KEY_BASE64 = encryptionKey;

  process.stdout.write("seeding dev fixtures for ownerA:\n");
  await command("node", ["scripts/seed-dev-fixtures.mjs"], {
    env: {
      ...process.env,
      DATABASE_URL: adminUrl,
      DEV_ENCRYPTION_KEY_BASE64: encryptionKey,
      DEV_OWNER_ID: ownerA,
      DEV_OWNER_EMAIL: "whatsapp-owner-a@example.test",
      DEV_OWNER_NAME: "WhatsApp Owner A",
    },
  });
  process.stdout.write("  ✓ ownerA fixtures seeded\n");

  await withClient(adminUrl, async (client) => {
    await client.query(
      `INSERT INTO channel_accounts (
         owner_id,
         provider,
         external_user_id,
         external_thread_id,
         status,
         raw_profile,
         last_seen_at
       )
       VALUES
         ($1::uuid, 'whatsapp', '15550001', 'phone-number-1:15550001', 'active', '{"source":"test"}'::jsonb, now()),
         ($1::uuid, 'whatsapp', '15550002', 'phone-number-1:15550002', 'revoked', '{"source":"test"}'::jsonb, now())`,
      [ownerA],
    );
  });
  process.stdout.write("  ✓ seeded active + revoked whatsapp channel accounts\n");

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
      WHATSAPP_WEBHOOK_SECRET: whatsappSecret,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });
  let serverError = "";
  nextChild.stderr.on("data", (chunk) => { serverError += chunk.toString(); });

  process.stdout.write(`booting next dev on :${port}...\n`);
  await waitForNext();
  process.stdout.write("server ready, running assertions:\n");

  {
    const res = await postWhatsApp(whatsappText({
      from: "15550001",
      text: "最近有什么需要跟进的关系吗？",
    }), { secret: null });
    check("missing WhatsApp secret header -> 401",
      res.status === 401 && res.body?.code === "unauthorized",
      `status=${res.status} body=${JSON.stringify(res.body)}`);
  }

  {
    const res = await postWhatsApp(whatsappText({
      from: "15550001",
      text: "最近有什么需要跟进的关系吗？",
    }), { secret: "wrong" });
    check("wrong WhatsApp secret header -> 401",
      res.status === 401 && res.body?.code === "unauthorized",
      `status=${res.status} body=${JSON.stringify(res.body)}`);
  }

  {
    const res = await postWhatsApp("{not json");
    check("malformed JSON -> 400",
      res.status === 400 && res.body?.code === "invalid_request",
      `status=${res.status} body=${JSON.stringify(res.body)}`);
  }

  {
    const res = await postWhatsApp(whatsappImage({ from: "15550001" }));
    check("non-text WhatsApp payload -> 200 ignored",
      res.status === 200 && res.body?.status === "ignored" && res.body?.code === "ignored",
      `status=${res.status} body=${JSON.stringify(res.body)}`);
    check("ignored payload has no reviewUrl",
      res.body?.reviewUrl === undefined,
      JSON.stringify(res.body));
  }

  {
    const res = await postWhatsApp(whatsappText({
      from: "15559999",
      text: "最近有什么需要跟进的关系吗？",
    }));
    check("unlinked WhatsApp user -> 200",
      res.status === 200, `status=${res.status}`);
    check("unlinked status = needs_link",
      res.body?.status === "needs_link" && res.body?.code === "needs_link",
      JSON.stringify(res.body));
    check("unlinked reviewUrl -> profile command channels",
      res.body?.reviewUrl === "/profile#command-channels",
      JSON.stringify(res.body));
    check("unlinked response does NOT echo ownerId",
      res.body?.ownerId === undefined,
      JSON.stringify(res.body));
    check("unlinked reply is ReMaster-framed",
      res.body?.text?.includes("ReMaster") && !res.body?.text?.includes("Keepsake"),
      JSON.stringify(res.body));
    check("unlinked reply does NOT claim execution",
      noExecutionClaim(res.body),
      JSON.stringify(res.body));
  }

  const ownerAFixtureNames = ["Lin", "Mom", "Aisha", "Dad", "Kira"];
  {
    const res = await postWhatsApp(whatsappText({
      from: "15550001",
      text: "最近有什么需要跟进的关系吗？",
    }));
    check("active linked follow-up -> 200",
      res.status === 200, `status=${res.status}`);
    check("active linked follow-up status=ok",
      res.body?.status === "ok",
      JSON.stringify(res.body));
    check("active linked follow-up intent",
      res.body?.intent === "relationship_followup_query",
      JSON.stringify(res.body));
    check("active linked follow-up reviewUrl -> /people",
      res.body?.reviewUrl === "/people",
      JSON.stringify(res.body));
    check("active linked follow-up response does NOT echo ownerId",
      res.body?.ownerId === undefined,
      JSON.stringify(res.body));
    const text = typeof res.body?.text === "string" ? res.body.text : "";
    check("active linked follow-up names real fixture person",
      ownerAFixtureNames.some((name) => text.includes(name)),
      `text=${text}`);
    check("active linked follow-up is ReMaster-framed",
      text.includes("ReMaster") && !text.includes("Keepsake"),
      `text=${text}`);
    check("active linked follow-up does NOT claim execution",
      noExecutionClaim(res.body),
      JSON.stringify(res.body));
  }

  {
    const res = await postWhatsApp(whatsappText({
      from: "15550001",
      text: "帮我给 Helen 发一个邮件，她今天升职了，我要祝福她",
    }));
    check("active linked compose -> 200",
      res.status === 200, `status=${res.status}`);
    check("active linked compose status=needs_review",
      res.body?.status === "needs_review",
      JSON.stringify(res.body));
    check("active linked compose intent",
      res.body?.intent === "compose_request",
      JSON.stringify(res.body));
    check("active linked compose reviewUrl exists",
      typeof res.body?.reviewUrl === "string" && res.body.reviewUrl.length > 0,
      JSON.stringify(res.body));
    check("active linked compose reviewUrl opens Workspace",
      res.body?.reviewUrl?.startsWith("/workspace?"),
      JSON.stringify(res.body));
    check("active linked compose reviewUrl carries recipientHint",
      res.body?.reviewUrl?.includes("recipientHint=Helen"),
      JSON.stringify(res.body));
    check("active linked compose reviewUrl carries encoded contextHint",
      res.body?.reviewUrl?.includes("contextHint=")
        && decodeURIComponent(res.body.reviewUrl).includes("今天升职了"),
      JSON.stringify(res.body));
    check("active linked compose response does NOT echo ownerId",
      res.body?.ownerId === undefined,
      JSON.stringify(res.body));
    check("active linked compose is ReMaster-framed",
      JSON.stringify(res.body).includes("ReMaster")
        && !JSON.stringify(res.body).includes("Keepsake"),
      JSON.stringify(res.body));
    check("active linked compose does NOT claim sent/delivered/queued",
      noExecutionClaim(res.body),
      JSON.stringify(res.body));
  }

  {
    const res = await postWhatsApp(whatsappText({
      from: "15550002",
      text: "Send Helen an email — she got promoted today",
    }));
    check("revoked WhatsApp user -> 200",
      res.status === 200, `status=${res.status}`);
    check("revoked status = needs_link",
      res.body?.status === "needs_link" && res.body?.code === "needs_link",
      JSON.stringify(res.body));
    check("revoked has no suggestedAction",
      res.body?.suggestedAction === undefined,
      JSON.stringify(res.body));
    check("revoked reviewUrl -> profile command channels",
      res.body?.reviewUrl === "/profile#command-channels",
      JSON.stringify(res.body));
    check("revoked response does NOT echo ownerId",
      res.body?.ownerId === undefined,
      JSON.stringify(res.body));
    check("revoked reply is ReMaster-framed",
      res.body?.text?.includes("ReMaster") && !res.body?.text?.includes("Keepsake"),
      JSON.stringify(res.body));
  }

  if (serverError.includes("Error:")) {
    process.stdout.write("  note: Next stderr contained errors; assertions above decide pass/fail\n");
  }
} catch (error) {
  process.stdout.write(`harness error: ${error?.message ?? error}\n`);
  failures.push("harness");
} finally {
  await stopNext();
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
  process.stdout.write("\nall /api/channels/whatsapp DB checks passed\n");
  process.exit(0);
}
