// DB-backed smoke for the P8-F Profile "Command channels" UI +
// /api/channels/mock/{link,revoke} routes.
//
// Boots throwaway Postgres, creates two owners (A + B), seeds an
// existing ownerB link directly via the repo so the cross-owner
// revoke check is realistic, boots Next dev in
// KEEPSAKE_DATA_SOURCE=db mode as ownerA, mints a session cookie,
// and drives the round-trip:
//
//   1. Profile renders the channels section in DB mode + empty state.
//   2. POST /api/channels/telegram/link links a Telegram identity → 303.
//   3. Profile renders the Telegram row + provider-specific revoke form.
//   4. POST /api/channels/telegram/revoke revokes that identity → 303.
//   5. POST /api/channels/mock/link links a new mock identity → 303.
//   6. Profile renders the linked row + accountId, no fake "Sending"
//      regressions.
//   7. POST /api/channels/mock/inbound with the linked externalUserId
//      resolves owner_id and returns the owner-scoped follow-up text.
//   8. POST /api/channels/mock/revoke (cross-owner) → 404 not_found.
//   9. POST /api/channels/mock/revoke (owner) → 303.
//   10. Profile now shows the row as Revoked.
//   11. POST inbound with the now-revoked externalUserId → needs_link.
//   12. Body-shape errors: empty externalUserId → 400; bogus accountId
//      → 400; unauthenticated revoke → 401.

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
const containerName = `keepsake-test-channel-profile-${Date.now()}`;
const postgresImage = "postgres:17-alpine";
const appRole = "keepsake_app";
const appPassword = "keepsake_app";
const port = Number(process.env.TEST_CHANNEL_PROFILE_DB_PORT ?? 3222);
const base = `http://localhost:${port}`;
// Second next-dev instance for the no-session 401 phase. Runs with
// DEV_OWNER_* UNSET so `currentUserIdOrThrow()` has neither cookie
// nor env fallback and the link/revoke routes must answer 401.
const port401 = port + 1;
const base401 = `http://localhost:${port401}`;

let containerStarted = false;
let nextChild = null;
let helperClose = async () => {};
let helperCleanup = async () => {};

function cmd(commandName, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
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
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${commandName} ${args.join(" ")} failed: ${stderr || stdout}`));
    });
  });
}
async function docker(args) { return cmd("docker", args); }

async function withClient(databaseUrl, fn) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
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
  // Same transpile dance as the other repo smokes — we don't want to
  // pull in the Next.js build pipeline just to drive a worker tx.
  const tempRoot = join(projectRoot, ".next", "test-channel-profile");
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
  return { repo: mod.createChannelAccountRepository(), db };
}

async function waitForNext(target = base) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${target}/api/session`);
      // 401 / 500 are both "responsive" for this readiness probe —
      // the second boot intentionally has no env fallback so
      // `/api/session` will 401, but the server itself is up.
      if (r.status < 600) return;
    } catch {}
    await wait(500);
  }
  throw new Error(`Next dev did not become ready at ${target}`);
}

async function stopNext() {
  if (!nextChild) return;
  const child = nextChild;
  nextChild = null;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  const exited = await Promise.race([
    new Promise((r) => child.once("exit", () => r(true))),
    wait(3_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

const APP_SESSION_SECRET =
  "test-channel-profile-app-session-secret-min-32-chars";

let sessionCookie = "";
async function mintDevSession() {
  const r = await fetch(`${base}/api/auth/dev-session/start`, { method: "POST" });
  if (r.status !== 200) {
    throw new Error(`dev-session/start failed: status=${r.status}`);
  }
  const setCookie = r.headers.get("set-cookie") ?? "";
  sessionCookie = setCookie.match(/keepsake_session=([^;]+)/)?.[1] ?? "";
  if (!sessionCookie) throw new Error("dev-session/start returned no cookie");
}

async function getProfile() {
  const res = await fetch(`${base}/profile`, {
    headers: { cookie: `keepsake_session=${sessionCookie}` },
  });
  return { status: res.status, body: await res.text() };
}

async function postForm(path, fields, { withCookie = true } = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) params.set(k, String(v));
  }
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (withCookie && sessionCookie) {
    headers.cookie = `keepsake_session=${sessionCookie}`;
  }
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: params.toString(),
    redirect: "manual",
  });
  let json = null;
  try { json = await res.clone().json(); } catch {}
  return { status: res.status, body: json, location: res.headers.get("location") };
}

async function postInbound(body) {
  const res = await fetch(`${base}/api/channels/mock/inbound`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

const failures = [];
function check(name, cond, detail = "") {
  if (cond) process.stdout.write(`  ✓ ${name}\n`);
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
    "run", "--rm", "-d", "--name", containerName,
    "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=keepsake",
    "-p", "127.0.0.1::5432", postgresImage,
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
        gmail_account_status,
        relationship_kind,
        relationship_group,
        occasion_kind,
        tone,
        channel
      TO ${appRole}
    `);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON channel_accounts TO ${appRole}`);
    // currentSessionUserOrThrow hydrates sendingAccount even on /profile
    await client.query(`GRANT SELECT ON gmail_accounts TO ${appRole}`);
    // handleOwnerCommand (P8-E) reads listWithRelations during inbound
    // follow-up, even when the owner has no seeded fixtures (returns
    // empty people + catalog content + empty-window text).
    await client.query(`GRANT SELECT ON people, occasion_nodes, relationships, cultures TO ${appRole}`);
    await client.query(`GRANT EXECUTE ON FUNCTION current_user_id() TO ${appRole}`);
  });

  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const encryptionKey = randomBytes(32).toString("base64");

  await withClient(adminUrl, async (client) => {
    await client.query(
      `INSERT INTO users (id, email, display_name)
       VALUES ($1, 'profile-owner-a@example.test', 'Profile Owner A'),
              ($2, 'profile-owner-b@example.test', 'Profile Owner B')`,
      [ownerA, ownerB],
    );
  });

  // Pre-link ownerB → mock-b-1 via the repo so step 5's cross-owner
  // revoke attempt has a real target id.
  process.env.DATABASE_URL = appUrl;
  process.env.KEEPSAKE_WORKER_DATABASE_URL = adminUrl;
  process.env.DEV_ENCRYPTION_KEY_BASE64 = encryptionKey;
  const { repo } = await loadChannelAccountRepository();
  const ownerBLink = await repo.link(ownerB, {
    provider: "mock",
    externalUserId: "mock-b-1",
    displayName: "Owner B's channel",
  });
  process.stdout.write("  ✓ pre-linked ownerB mock identity\n");

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
      DEV_OWNER_EMAIL: "profile-owner-a@example.test",
      DEV_OWNER_NAME: "Profile Owner A",
      KEEPSAKE_DATA_SOURCE: "db",
      TELEGRAM_BOT_USERNAME: "KeepsakeTestBot",
      NEXT_TELEMETRY_DISABLED: "1",
      APP_SESSION_SIGNING_SECRET: APP_SESSION_SECRET,
      ENABLE_DEV_SESSION_ROUTES: "1",
    },
  });
  let serverError = "";
  nextChild.stderr.on("data", (chunk) => { serverError += chunk.toString(); });

  process.stdout.write(`booting next dev on :${port}...\n`);
  await waitForNext();
  await mintDevSession();
  process.stdout.write("server ready, running assertions:\n");

  // 1. Empty-state Profile render
  {
    const { status, body } = await getProfile();
    check("/profile -> 200", status === 200, `status=${status}`);
    check("renders COMMAND CHANNELS section",
      body.includes("COMMAND CHANNELS"));
    check("renders DB-mode channels section attr",
      body.includes('data-channel-data-source="db"'));
    check("renders empty-state placeholder",
      body.includes('data-testid="profile-channels-empty"'));
    check("does NOT render mock-mode placeholder",
      !body.includes('data-channel-data-source="mock"'));
    check("renders the link form",
      body.includes('data-testid="profile-channels-link-form"'));
    check("link form posts to /api/channels/mock/link",
      body.includes('action="/api/channels/mock/link"'));
    check("renders the Telegram link form",
      body.includes('data-testid="profile-channels-telegram-link-form"'));
    check("Telegram form posts to /api/channels/telegram/link",
      body.includes('action="/api/channels/telegram/link"'));
    check("Telegram form is marked with provider hook",
      body.includes('data-channel-link-provider="telegram"'));
    check("renders the Telegram start-link row",
      body.includes('data-testid="profile-channels-telegram-start"'));
    check("renders the Telegram start link",
      body.includes('data-testid="profile-channels-telegram-start-link"'));
    const startMatch = body.match(/https:\/\/t\.me\/KeepsakeTestBot\?start=([A-Za-z0-9_-]+)/);
    check("Telegram start link points to configured bot",
      Boolean(startMatch),
      "missing https://t.me/KeepsakeTestBot?start=...");
    check("Telegram start token fits Telegram deep-link limit",
      (startMatch?.[1]?.length ?? 999) <= 64,
      `length=${startMatch?.[1]?.length ?? "missing"}`);
    check("does NOT render any linked row yet",
      !body.includes('data-testid="profile-channels-row"'));
    check("does NOT leak ownerB id into the page",
      !body.includes(ownerB),
      "ownerB id appeared in /profile HTML");
  }

  // 2. POST Telegram link → 303
  let telegramAccountId = "";
  {
    const res = await postForm("/api/channels/telegram/link", {
      externalUserId: "1001",
      displayName: "OwnerA Telegram",
    });
    check("POST Telegram link -> 303", res.status === 303, `status=${res.status}`);
    check("POST Telegram link redirects to /profile#command-channels",
      (res.location ?? "").endsWith("/profile#command-channels"),
      `location=${res.location}`);
  }

  // 3. /profile now shows the Telegram row + provider-specific revoke
  {
    const { body } = await getProfile();
    check("renders the Telegram row",
      /data-channel-provider="telegram"/.test(body));
    check("renders the Telegram displayName",
      body.includes("OwnerA Telegram"));
    check("renders the Telegram externalUserId",
      body.includes("1001"));
    check("Telegram row posts revoke to /api/channels/telegram/revoke",
      /data-channel-provider="telegram"[\s\S]{0,2400}?action="\/api\/channels\/telegram\/revoke"/
        .test(body));
    const idMatch = body.match(
      /data-channel-provider="telegram"[\s\S]{0,2400}?name="accountId"\s+value="([0-9a-f-]{36})"/i,
    );
    telegramAccountId = idMatch?.[1] ?? "";
    check("can extract Telegram accountId from the rendered revoke form",
      /^[0-9a-f-]{36}$/i.test(telegramAccountId),
      `accountId=${telegramAccountId}`);
  }

  // 4. Same-owner Telegram revoke → 303
  {
    const res = await postForm("/api/channels/telegram/revoke", {
      accountId: telegramAccountId,
    });
    check("same-owner Telegram revoke -> 303", res.status === 303,
      `status=${res.status} body=${JSON.stringify(res.body)}`);
    check("Telegram revoke redirects to /profile#command-channels",
      (res.location ?? "").endsWith("/profile#command-channels"));
  }

  // 5. /profile now shows the Telegram row as revoked
  {
    const { body } = await getProfile();
    check("revoked Telegram row still present in /profile",
      body.includes(`data-channel-account-id="${telegramAccountId}"`));
    check("revoked Telegram row status pill = revoked",
      new RegExp(`data-channel-account-id="${telegramAccountId}"[^>]*data-channel-status="revoked"`)
        .test(body),
      "Telegram row did not flip to revoked");
  }

  // 6. POST mock link → 303
  {
    const res = await postForm("/api/channels/mock/link", {
      externalUserId: "mock-a-1",
      displayName: "OwnerA primary channel",
    });
    check("POST link -> 303", res.status === 303, `status=${res.status}`);
    check("POST link redirects to /profile",
      (res.location ?? "").endsWith("/profile"),
      `location=${res.location}`);
  }

  // 7. /profile now shows the linked mock row
  let linkedAccountId = "";
  {
    const { body } = await getProfile();
    check("renders the freshly linked row",
      body.includes('data-testid="profile-channels-row"'));
    check("renders the linked externalUserId in the row",
      body.includes("mock-a-1"));
    check("renders the active status pill",
      /data-channel-status="active"/.test(body));
    check("renders the chosen displayName",
      body.includes("OwnerA primary channel"));
    check("renders a revoke form for the active row",
      body.includes('data-testid="profile-channels-revoke-form"'));
    check("does NOT render anyone else's externalUserId",
      !body.includes("mock-b-1"));

    const idMatch = body.match(
      /name="accountId"\s+value="([0-9a-f-]{36})"/i,
    );
    linkedAccountId = idMatch?.[1] ?? "";
    check("can extract accountId from the rendered revoke form",
      /^[0-9a-f-]{36}$/i.test(linkedAccountId),
      `accountId=${linkedAccountId}`);
  }

  // 4. inbound with the linked externalUserId resolves owner_id and
  //    returns the owner-scoped follow-up text (P8-D + P8-E paths).
  {
    const res = await postInbound({
      externalUserId: "mock-a-1",
      text: "Anyone I should follow up with?",
    });
    check("inbound (active) -> 200", res.status === 200);
    check("inbound (active) status=ok",
      res.body?.status === "ok", JSON.stringify(res.body));
    check("inbound (active) intent matches follow-up",
      res.body?.intent === "relationship_followup_query");
    check("inbound (active) echoes ownerA",
      res.body?.ownerId === ownerA,
      JSON.stringify(res.body));
    // ownerA has no seeded fixtures in this smoke (we focus on
    // link/revoke, not follow-up content); the empty-window message
    // should land.
    check("inbound (active) returns the empty-window response",
      /nothing in the next/i.test(res.body?.text ?? ""),
      res.body?.text);
  }

  // 5. Cross-owner revoke → 404. The pre-linked ownerB row's id is
  //    a UUID, so it passes the body validator; the repo refuses to
  //    touch it under ownerA's transaction.
  {
    const res = await postForm("/api/channels/mock/revoke", {
      accountId: ownerBLink.id,
    });
    check("cross-owner revoke -> 404", res.status === 404,
      `status=${res.status} body=${JSON.stringify(res.body)}`);
    check("cross-owner revoke code=not_found",
      res.body?.code === "not_found");
  }

  // 6. Same-owner revoke → 303
  {
    const res = await postForm("/api/channels/mock/revoke", {
      accountId: linkedAccountId,
    });
    check("same-owner revoke -> 303", res.status === 303,
      `status=${res.status} body=${JSON.stringify(res.body)}`);
    check("revoke redirects to /profile",
      (res.location ?? "").endsWith("/profile"));
  }

  // 7. /profile now shows the row as revoked + no revoke form
  {
    const { body } = await getProfile();
    check("revoked row still present in /profile",
      body.includes(`data-channel-account-id="${linkedAccountId}"`));
    check("revoked row status pill = revoked",
      new RegExp(`data-channel-account-id="${linkedAccountId}"[^>]*data-channel-status="revoked"`)
        .test(body),
      "row did not flip to revoked");
    check("revoked row removes its revoke form",
      !new RegExp(
        `data-channel-account-id="${linkedAccountId}"[\\s\\S]{0,2000}?data-testid="profile-channels-revoke-form"`,
      ).test(body));
  }

  // 8. inbound with the now-revoked externalUserId → needs_link
  {
    const res = await postInbound({
      externalUserId: "mock-a-1",
      text: "Anyone I should follow up with?",
    });
    check("inbound (revoked) -> 200", res.status === 200);
    check("inbound (revoked) status=needs_link",
      res.body?.status === "needs_link" && res.body?.code === "needs_link",
      JSON.stringify(res.body));
    check("inbound (revoked) does not echo ownerId",
      res.body?.ownerId === undefined);
  }

  // 9. Body-shape errors
  {
    const res = await postForm("/api/channels/mock/link", {
      externalUserId: "   ",
    });
    check("link with empty externalUserId -> 400",
      res.status === 400 && res.body?.code === "invalid_request",
      `status=${res.status} body=${JSON.stringify(res.body)}`);
  }
  {
    const res = await postForm("/api/channels/telegram/link", {
      externalUserId: "   ",
    });
    check("Telegram link with empty externalUserId -> 400",
      res.status === 400 && res.body?.code === "invalid_request",
      `status=${res.status} body=${JSON.stringify(res.body)}`);
  }
  {
    const res = await postForm("/api/channels/mock/revoke", {
      accountId: "not-a-uuid",
    });
    check("revoke with non-uuid accountId -> 400",
      res.status === 400 && res.body?.code === "invalid_request",
      `status=${res.status} body=${JSON.stringify(res.body)}`);
  }
  {
    const res = await postForm("/api/channels/telegram/revoke", {
      accountId: "not-a-uuid",
    });
    check("Telegram revoke with non-uuid accountId -> 400",
      res.status === 400 && res.body?.code === "invalid_request",
      `status=${res.status} body=${JSON.stringify(res.body)}`);
  }
  {
    // Sanity pin for the env-fallback path (cookie missing, but
    // DEV_OWNER_* IS set on this dev server): the route should
    // still authenticate via the env fallback and reach the seam,
    // where the bogus uuid surfaces as 404 not_found rather than
    // 401. The strict no-session 401 contract is exercised in the
    // separate boot below.
    const res = await postForm("/api/channels/mock/revoke", {
      accountId: "00000000-0000-4000-8000-000000000000",
    }, { withCookie: false });
    check("revoke unknown uuid (env-fallback owner) -> 404",
      res.status === 404 && res.body?.code === "not_found",
      `status=${res.status} body=${JSON.stringify(res.body)}`);
  }

  // ── Phase 2: no-session 401 contract ──────────────────────────────
  // Stop the current next-dev (still has DEV_OWNER_*) and boot a
  // SECOND instance with DEV_OWNER_* unset so the cookie-first +
  // env-fallback chain has nothing to land on. `currentUserIdOrThrow()`
  // must raise `AuthError("unauthenticated")` BEFORE any DB touch,
  // and the routes must surface that as 401 + { code:
  // "unauthenticated" }.
  process.stdout.write("\nphase 2 — strict 401 with no cookie + no DEV_OWNER_*:\n");
  await stopNext();

  nextChild = spawn(nextBin, ["dev", "--port", String(port401)], {
    cwd: projectRoot,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      BROWSER: "none",
      DATABASE_URL: appUrl,
      KEEPSAKE_WORKER_DATABASE_URL: adminUrl,
      DEV_ENCRYPTION_KEY_BASE64: encryptionKey,
      KEEPSAKE_DATA_SOURCE: "db",
      NEXT_TELEMETRY_DISABLED: "1",
      APP_SESSION_SIGNING_SECRET: APP_SESSION_SECRET,
      // DEV_OWNER_ID / DEV_OWNER_EMAIL / DEV_OWNER_NAME deliberately
      // omitted so `currentUserIdOrThrow()` has nothing to fall back
      // on. ENABLE_DEV_SESSION_ROUTES also omitted — no need.
    },
  });
  let serverError401 = "";
  nextChild.stderr.on("data", (chunk) => { serverError401 += chunk.toString(); });

  process.stdout.write(`booting next dev on :${port401} (no env fallback)...\n`);
  await waitForNext(base401);

  async function postNoSession(path, fields) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) params.set(k, String(v));
    }
    const res = await fetch(`${base401}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual",
    });
    let json = null;
    try { json = await res.clone().json(); } catch {}
    return { status: res.status, body: json };
  }

  {
    const res = await postNoSession("/api/channels/mock/link", {
      externalUserId: "would-not-matter",
      displayName: "ignored",
    });
    check("no-session POST /link -> 401",
      res.status === 401,
      `status=${res.status} body=${JSON.stringify(res.body)}`);
    check("no-session POST /link code=unauthenticated",
      res.body?.code === "unauthenticated",
      JSON.stringify(res.body));
  }
  {
    const res = await postNoSession("/api/channels/telegram/link", {
      externalUserId: "would-not-matter",
      displayName: "ignored",
    });
    check("no-session POST /telegram/link -> 401",
      res.status === 401,
      `status=${res.status} body=${JSON.stringify(res.body)}`);
    check("no-session POST /telegram/link code=unauthenticated",
      res.body?.code === "unauthenticated",
      JSON.stringify(res.body));
  }
  {
    const res = await postNoSession("/api/channels/mock/revoke", {
      // Valid uuid so the body validator passes — the route must
      // still 401 BEFORE doing any DB lookup.
      accountId: "00000000-0000-4000-8000-000000000000",
    });
    check("no-session POST /revoke -> 401",
      res.status === 401,
      `status=${res.status} body=${JSON.stringify(res.body)}`);
    check("no-session POST /revoke code=unauthenticated",
      res.body?.code === "unauthenticated",
      JSON.stringify(res.body));
  }
  {
    const res = await postNoSession("/api/channels/telegram/revoke", {
      accountId: "00000000-0000-4000-8000-000000000000",
    });
    check("no-session POST /telegram/revoke -> 401",
      res.status === 401,
      `status=${res.status} body=${JSON.stringify(res.body)}`);
    check("no-session POST /telegram/revoke code=unauthenticated",
      res.body?.code === "unauthenticated",
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
  process.stdout.write("\nall channel-account profile DB checks passed\n");
  process.exit(0);
}
