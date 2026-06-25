// DB-backed smoke for POST /api/channels/telegram (P8-H).
//
// Boots throwaway Postgres, links Telegram identities through
// ChannelAccountRepository, starts Next in KEEPSAKE_DATA_SOURCE=db mode, and
// points TELEGRAM_API_BASE at a local sendMessage stub. No real Telegram
// network calls, no web session, no DEV_OWNER fallback, no draft/send effects.

import { createServer } from "node:http";
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
const containerName = `keepsake-test-channels-telegram-${Date.now()}`;
const postgresImage = "postgres:17-alpine";
const appRole = "keepsake_app";
const appPassword = "keepsake_app";
const port = Number(process.env.TEST_CHANNELS_TELEGRAM_DB_PORT ?? 3224);
const stubPort = Number(process.env.TEST_CHANNELS_TELEGRAM_STUB_PORT ?? 3225);
const base = `http://localhost:${port}`;
const telegramSecret = "telegram-secret-token-test";
const telegramBotToken = "123456:test-bot-token";
const telegramBotUsername = "KeepsakeTestBot";
const appSessionSecret = "test-channels-telegram-app-session-secret-min-32-chars";

let containerStarted = false;
let nextChild = null;
let stub = null;
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
  const tempRoot = join(projectRoot, ".next", "test-channels-telegram");
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

  helperClose = db.__closePoolForTest;
  return mod.createChannelAccountRepository();
}

async function startTelegramStub() {
  const requests = [];
  let nextMessageId = 7000;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {}
    requests.push({
      method: req.method,
      url: req.url,
      body,
    });

    if (req.method !== "POST" || req.url !== `/bot${telegramBotToken}/sendMessage`) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      result: { message_id: nextMessageId++ },
    }));
  });

  await new Promise((resolveListen) => {
    server.listen(stubPort, "127.0.0.1", resolveListen);
  });
  return {
    requests,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

async function waitForNext() {
  const deadline = Date.now() + 60_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await postTelegram("{not json");
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

async function postTelegram(body, { secret = telegramSecret } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret !== null) headers["x-telegram-bot-api-secret-token"] = secret;
  const res = await fetch(`${base}/api/channels/telegram`, {
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

async function mintDevSession() {
  const res = await fetch(`${base}/api/auth/dev-session/start`, { method: "POST" });
  if (res.status !== 200) {
    throw new Error(`dev-session/start failed: status=${res.status}`);
  }
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.match(/keepsake_session=([^;]+)/)?.[1] ?? "";
  if (!cookie) throw new Error("dev-session/start returned no keepsake_session cookie");
  return cookie;
}

async function getProfile(sessionCookie) {
  const res = await fetch(`${base}/profile`, {
    headers: { cookie: `keepsake_session=${sessionCookie}` },
  });
  return { status: res.status, body: await res.text() };
}

function telegramUpdate({ fromId, chatId, text }) {
  return {
    update_id: 900001,
    message: {
      message_id: 11,
      date: 1782000000,
      text,
      from: {
        id: fromId,
        is_bot: false,
        first_name: "Channel",
      },
      chat: {
        id: chatId,
        type: "private",
      },
    },
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

function lastTelegramText() {
  const request = stub.requests[stub.requests.length - 1];
  return typeof request?.body?.text === "string" ? request.body.text : "";
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
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON channel_accounts TO ${appRole}`);
    await client.query(`GRANT SELECT ON gmail_accounts TO ${appRole}`);
    await client.query(`GRANT SELECT ON people, occasion_nodes, relationships, cultures TO ${appRole}`);
    await client.query(`GRANT EXECUTE ON FUNCTION current_user_id() TO ${appRole}`);
  });

  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const encryptionKey = randomBytes(32).toString("base64");

  await withClient(adminUrl, async (client) => {
    await client.query(
      `INSERT INTO users (id, email, display_name)
       VALUES ($1, 'telegram-owner-a@example.test', 'Telegram Owner A'),
              ($2, 'telegram-owner-b@example.test', 'Telegram Owner B')`,
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
      DEV_OWNER_EMAIL: "telegram-owner-a@example.test",
      DEV_OWNER_NAME: "Telegram Owner A",
    },
  });
  process.stdout.write("  ✓ ownerA fixtures seeded\n");

  const repo = await loadChannelAccountRepository();
  await repo.link(ownerA, {
    provider: "telegram",
    externalUserId: "1001",
    externalThreadId: "chat-1001",
    displayName: "Telegram Active",
    rawProfile: { source: "test" },
  });
  await repo.link(ownerB, {
    provider: "telegram",
    externalUserId: "2002",
    externalThreadId: "chat-2002",
    displayName: "Telegram Owner B",
  });
  const revoked = await repo.link(ownerA, {
    provider: "telegram",
    externalUserId: "1002",
    externalThreadId: "chat-1002",
    displayName: "Telegram Revoked",
  });
  await repo.markRevoked(ownerA, revoked.id);
  process.stdout.write("  ✓ linked active + revoked telegram channel accounts\n");

  stub = await startTelegramStub();
  process.stdout.write(`  ✓ telegram API stub listening on :${stubPort}\n`);

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
      DEV_OWNER_ID: ownerA,
      DEV_OWNER_EMAIL: "telegram-owner-a@example.test",
      DEV_OWNER_NAME: "Telegram Owner A",
      KEEPSAKE_DATA_SOURCE: "db",
      TELEGRAM_WEBHOOK_SECRET: telegramSecret,
      TELEGRAM_BOT_TOKEN: telegramBotToken,
      TELEGRAM_BOT_USERNAME: telegramBotUsername,
      TELEGRAM_API_BASE: `http://127.0.0.1:${stubPort}`,
      KEEPSAKE_APP_ORIGIN: base,
      APP_SESSION_SIGNING_SECRET: appSessionSecret,
      ENABLE_DEV_SESSION_ROUTES: "1",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });
  let serverError = "";
  nextChild.stderr.on("data", (chunk) => { serverError += chunk.toString(); });

  process.stdout.write(`booting next dev on :${port}...\n`);
  await waitForNext();
  process.stdout.write("server ready, running assertions:\n");

  let startToken = "";
  {
    const sessionCookie = await mintDevSession();
    const profile = await getProfile(sessionCookie);
    check("/profile for Telegram start link -> 200",
      profile.status === 200,
      `status=${profile.status}`);
    check("Profile renders Telegram start link CTA",
      profile.body.includes('data-testid="profile-channels-telegram-start-link"'));
    const match = profile.body.match(/https:\/\/t\.me\/KeepsakeTestBot\?start=([A-Za-z0-9_-]+)/);
    startToken = match?.[1] ?? "";
    check("Profile start link targets configured bot",
      Boolean(match),
      "missing t.me start link");
    check("Profile start token fits Telegram's 64-char limit",
      startToken.length > 0 && startToken.length <= 64,
      `length=${startToken.length}`);
  }

  {
    const before = stub.requests.length;
    const res = await postTelegram(telegramUpdate({
      fromId: 1001,
      chatId: 5001,
      text: "最近有什么需要跟进的关系吗？",
    }), { secret: null });
    check("missing Telegram secret header -> 401",
      res.status === 401 && res.body?.code === "unauthorized",
      `status=${res.status} body=${JSON.stringify(res.body)}`);
    check("missing secret does NOT call sendMessage",
      stub.requests.length === before);
  }

  {
    const before = stub.requests.length;
    const res = await postTelegram(telegramUpdate({
      fromId: 1001,
      chatId: 5001,
      text: "最近有什么需要跟进的关系吗？",
    }), { secret: "wrong" });
    check("wrong Telegram secret header -> 401",
      res.status === 401 && res.body?.code === "unauthorized",
      `status=${res.status} body=${JSON.stringify(res.body)}`);
    check("wrong secret does NOT call sendMessage",
      stub.requests.length === before);
  }

  {
    const before = stub.requests.length;
    const res = await postTelegram("{not json");
    check("malformed JSON -> 400",
      res.status === 400 && res.body?.code === "invalid_request",
      `status=${res.status} body=${JSON.stringify(res.body)}`);
    check("malformed JSON does NOT call sendMessage",
      stub.requests.length === before);
  }

  {
    const before = stub.requests.length;
    const res = await postTelegram({ update_id: 1, message: { chat: { id: 5 } } });
    check("non-text / unresolvable update -> 200",
      res.status === 200 && res.body?.status === "ignored",
      `status=${res.status} body=${JSON.stringify(res.body)}`);
    check("ignored update does NOT call sendMessage",
      stub.requests.length === before);
  }

  {
    const before = stub.requests.length;
    const res = await postTelegram(telegramUpdate({
      fromId: 9999,
      chatId: 5999,
      text: "最近有什么需要跟进的关系吗？",
    }));
    check("unlinked Telegram user -> 200",
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
    check("unlinked sends exactly one Telegram message",
      stub.requests.length === before + 1);
    const text = lastTelegramText();
    check("unlinked Telegram text links to Profile anchor",
      text.includes(`${base}/profile#command-channels`),
      `text=${text}`);
    check("unlinked Telegram text is ReMaster-framed",
      text.includes("ReMaster") && !text.includes("Keepsake"),
      `text=${text}`);
    check("unlinked Telegram text does NOT claim execution",
      !/\b(sent|delivered|queued)\b/i.test(text),
      `text=${text}`);
  }

  {
    const before = stub.requests.length;
    const res = await postTelegram(telegramUpdate({
      fromId: 3003,
      chatId: 5303,
      text: `/start ${startToken}`,
    }));
    check("/start token -> 200",
      res.status === 200,
      `status=${res.status} body=${JSON.stringify(res.body)}`);
    check("/start token links the account",
      res.body?.status === "ok" && res.body?.code === "linked",
      JSON.stringify(res.body));
    check("/start response does NOT echo ownerId",
      res.body?.ownerId === undefined,
      JSON.stringify(res.body));
    check("/start sends Telegram message",
      stub.requests.length === before + 1);
    const text = lastTelegramText();
    check("/start Telegram text confirms ReMaster link",
      /linked to ReMaster/i.test(text),
      `text=${text}`);
    check("/start Telegram text links to Profile",
      text.includes(`${base}/profile#command-channels`),
      `text=${text}`);
    check("/start Telegram text does NOT mention Keepsake",
      !text.includes("Keepsake"),
      `text=${text}`);
    check("/start Telegram text does NOT claim execution",
      !/\b(sent|delivered|queued)\b/i.test(text),
      `text=${text}`);
    const row = await withClient(adminUrl, async (client) => {
      const result = await client.query(
        `SELECT owner_id, external_thread_id, status
           FROM channel_accounts
          WHERE provider = 'telegram' AND external_user_id = '3003'`,
      );
      return result.rows[0];
    });
    check("/start inserted channel account for ownerA",
      row?.owner_id === ownerA,
      JSON.stringify(row));
    check("/start stored the Telegram chat id as thread id",
      row?.external_thread_id === "5303",
      JSON.stringify(row));
    check("/start row is active",
      row?.status === "active",
      JSON.stringify(row));
  }

  {
    const before = stub.requests.length;
    const badToken = `${startToken.slice(0, -1)}${startToken.endsWith("A") ? "B" : "A"}`;
    const res = await postTelegram(telegramUpdate({
      fromId: 4004,
      chatId: 5404,
      text: `/start ${badToken}`,
    }));
    check("tampered /start token -> 200",
      res.status === 200,
      `status=${res.status} body=${JSON.stringify(res.body)}`);
    check("tampered /start token asks for a fresh link",
      res.body?.status === "needs_link" && res.body?.code === "invalid_link",
      JSON.stringify(res.body));
    check("tampered /start sends exactly one Telegram message",
      stub.requests.length === before + 1);
    check("tampered /start text is ReMaster-framed",
      lastTelegramText().includes("ReMaster")
        && !lastTelegramText().includes("Keepsake"),
      `text=${lastTelegramText()}`);
    const rowCount = await withClient(adminUrl, async (client) => {
      const result = await client.query(
        `SELECT count(*)::int AS count
           FROM channel_accounts
          WHERE provider = 'telegram' AND external_user_id = '4004'`,
      );
      return result.rows[0]?.count ?? -1;
    });
    check("tampered /start did NOT insert a channel account",
      rowCount === 0,
      `count=${rowCount}`);
  }

  {
    const before = stub.requests.length;
    const res = await postTelegram(telegramUpdate({
      fromId: 2002,
      chatId: 6002,
      text: `/start ${startToken}`,
    }));
    check("cross-owner /start token -> 200",
      res.status === 200,
      `status=${res.status} body=${JSON.stringify(res.body)}`);
    check("cross-owner /start reports already_linked",
      res.body?.status === "needs_link" && res.body?.code === "already_linked",
      JSON.stringify(res.body));
    check("cross-owner /start sends Telegram message",
      stub.requests.length === before + 1);
    check("cross-owner /start text is ReMaster-framed",
      lastTelegramText().includes("ReMaster")
        && !lastTelegramText().includes("Keepsake"),
      `text=${lastTelegramText()}`);
    const row = await withClient(adminUrl, async (client) => {
      const result = await client.query(
        `SELECT owner_id, status
           FROM channel_accounts
          WHERE provider = 'telegram' AND external_user_id = '2002'`,
      );
      return result.rows[0];
    });
    check("cross-owner /start did NOT rebind ownerB row",
      row?.owner_id === ownerB,
      JSON.stringify(row));
  }

  const ownerAFixtureNames = ["Lin", "Mom", "Aisha", "Dad", "Kira"];
  {
    const before = stub.requests.length;
    const res = await postTelegram(telegramUpdate({
      fromId: 3003,
      chatId: 5303,
      text: "最近有什么需要跟进的关系吗？",
    }));
    check("newly linked /start account follow-up -> 200",
      res.status === 200);
    check("newly linked /start account status=ok",
      res.body?.status === "ok",
      JSON.stringify(res.body));
    check("newly linked /start account uses ownerA data",
      ownerAFixtureNames.some((name) => lastTelegramText().includes(name)),
      `text=${lastTelegramText()}`);
    check("newly linked /start account sent one Telegram message",
      stub.requests.length === before + 1);
  }

  {
    const before = stub.requests.length;
    const res = await postTelegram(telegramUpdate({
      fromId: 1001,
      chatId: 5001,
      text: "最近有什么需要跟进的关系吗？",
    }));
    check("active follow-up -> 200", res.status === 200);
    check("active follow-up status=ok",
      res.body?.status === "ok", JSON.stringify(res.body));
    check("active follow-up intent",
      res.body?.intent === "relationship_followup_query",
      JSON.stringify(res.body));
    check("active follow-up reviewUrl -> /people",
      res.body?.reviewUrl === "/people",
      JSON.stringify(res.body));
    check("active follow-up response does NOT echo ownerId",
      res.body?.ownerId === undefined,
      JSON.stringify(res.body));
    check("active follow-up sends Telegram message",
      stub.requests.length === before + 1);
    const text = lastTelegramText();
    check("active follow-up Telegram text names real fixture person",
      ownerAFixtureNames.some((name) => text.includes(name)),
      `text=${text}`);
    check("active follow-up Telegram text links to /people",
      text.includes(`${base}/people`),
      `text=${text}`);
    check("active follow-up Telegram text is ReMaster-framed",
      text.includes("ReMaster") && !text.includes("Keepsake"),
      `text=${text}`);
    check("active follow-up Telegram text does NOT claim execution",
      !/\b(sent|delivered|queued)\b/i.test(text),
      `text=${text}`);
    const request = stub.requests[stub.requests.length - 1];
    check("sendMessage targets Telegram chat id",
      request.body?.chat_id === "5001",
      JSON.stringify(request.body));
  }

  {
    const res = await postTelegram(telegramUpdate({
      fromId: 2002,
      chatId: 6002,
      text: "最近有什么需要跟进的关系吗？",
    }));
    check("ownerB follow-up -> 200", res.status === 200);
    check("ownerB follow-up status=ok",
      res.body?.status === "ok", JSON.stringify(res.body));
    const text = lastTelegramText();
    const leakedName = ownerAFixtureNames.find((name) => text.includes(name));
    check("ownerB Telegram text does NOT leak ownerA fixture names",
      leakedName === undefined,
      `leaked=${leakedName ?? ""} text=${text}`);
    check("ownerB Telegram text uses empty-window response",
      /nothing\s+in\s+the\s+next/i.test(text),
      `text=${text}`);
    check("ownerB Telegram text is ReMaster-framed",
      text.includes("ReMaster") && !text.includes("Keepsake"),
      `text=${text}`);
  }

  {
    const before = stub.requests.length;
    const res = await postTelegram(telegramUpdate({
      fromId: 1001,
      chatId: 5001,
      text: "帮我给 Helen 发一个邮件，她今天升职了，我要祝福她",
    }));
    check("active compose -> 200", res.status === 200);
    check("active compose status=needs_review",
      res.body?.status === "needs_review",
      JSON.stringify(res.body));
    check("active compose intent",
      res.body?.intent === "compose_request",
      JSON.stringify(res.body));
    check("active compose reviewUrl opens Workspace",
      typeof res.body?.reviewUrl === "string"
        && res.body.reviewUrl.startsWith("/workspace?"),
      JSON.stringify(res.body));
    check("active compose response does NOT echo ownerId",
      res.body?.ownerId === undefined,
      JSON.stringify(res.body));
    check("active compose sends Telegram message",
      stub.requests.length === before + 1);
    const text = lastTelegramText();
    check("active compose Telegram text links to Workspace",
      text.includes(`${base}/workspace?`),
      `text=${text}`);
    check("active compose Telegram text carries recipientHint",
      text.includes("recipientHint=Helen"),
      `text=${text}`);
    check("active compose Telegram text carries encoded contextHint",
      text.includes("contextHint=")
        && decodeURIComponent(text).includes("今天升职了"),
      `text=${text}`);
    check("active compose Telegram text is ReMaster-framed",
      text.includes("ReMaster") && !text.includes("Keepsake"),
      `text=${text}`);
    check("active compose Telegram text does NOT claim execution",
      !/\b(sent|delivered|queued)\b/i.test(text),
      `text=${text}`);
  }

  {
    const res = await postTelegram(telegramUpdate({
      fromId: 1002,
      chatId: 5002,
      text: "Send Helen an email — she got promoted today",
    }));
    check("revoked Telegram user -> 200",
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
    check("revoked Telegram text is ReMaster-framed",
      lastTelegramText().includes("ReMaster")
        && !lastTelegramText().includes("Keepsake"),
      `text=${lastTelegramText()}`);
  }
} catch (error) {
  process.stdout.write(`harness error: ${error?.message ?? error}\n`);
  failures.push("harness");
} finally {
  await stopNext();
  await helperClose().catch(() => {});
  await helperCleanup().catch(() => {});
  if (stub) await stub.close().catch(() => {});
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
  process.stdout.write("\nall /api/channels/telegram DB checks passed\n");
  process.exit(0);
}
