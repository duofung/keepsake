// DB-backed smoke for /api/auth/google/callback.
//
// Boots throwaway Postgres + a local Google token-endpoint stub, then
// drives /api/auth/google/start -> /api/auth/google/callback end-to-end:
//
//   * new email → users row created, session cookie minted
//   * existing email → SAME users.id reused, fresh session cookie minted
//   * /api/session with the minted cookie returns the persisted user
//
// Run via: pnpm test:db:google-signin

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = normalize(join(__dirname, ".."));
const containerName = `keepsake-test-google-signin-${Date.now()}`;
const postgresImage = "postgres:17-alpine";
const appRole = "keepsake_app";
const appPassword = "keepsake_app";
const port = Number(process.env.TEST_GOOGLE_SIGNIN_DB_PORT ?? 3186);
const stubPort = Number(process.env.TEST_GOOGLE_SIGNIN_DB_STUB_PORT ?? 3187);
const base = `http://localhost:${port}`;

let containerStarted = false;
let nextChild = null;
let stub = null;

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
async function docker(args) { return command("docker", args); }

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

async function waitForNext() {
  const deadline = Date.now() + 60_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/session`);
      if (res.status < 500) return;
      lastError = new Error(`status ${res.status}`);
    } catch (error) { lastError = error; }
    await wait(500);
  }
  throw new Error(`Next dev did not become ready at ${base}: ${lastError?.message ?? "unknown"}`);
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

// ── Google token endpoint stub ────────────────────────────────────────
const rig = { tokenCalls: [], nextIdToken: null };
function startStub() {
  return new Promise((resolveStarted, reject) => {
    const server = createServer((req, res) => {
      if (req.method !== "POST" || !req.url?.includes("/token")) {
        res.statusCode = 404; res.end(); return;
      }
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        rig.tokenCalls.push({ body });
        const idToken = rig.nextIdToken ?? makeIdToken();
        rig.nextIdToken = null;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id_token: idToken, access_token: "stub-access" }));
      });
    });
    server.on("error", reject);
    server.listen(stubPort, "127.0.0.1", () => resolveStarted(server));
  });
}
function makeIdToken({
  email = "stub@example.test",
  name = "Stub User",
  emailVerified = true,
} = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    email, name, email_verified: emailVerified,
  })).toString("base64url");
  return `${header}.${payload}.sig`;
}

const failures = [];
function check(name, cond, detail = "") {
  if (cond) process.stdout.write(`  ✓ ${name}\n`);
  else {
    process.stdout.write(`  ✗ ${name}${detail ? `  (${detail})` : ""}\n`);
    failures.push(name);
  }
}

// Drive one full sign-in. Returns the session cookie value.
async function signIn({ email, name }) {
  rig.nextIdToken = makeIdToken({ email, name });
  // 1. /start to mint state cookie
  const startRes = await fetch(`${base}/api/auth/google/start`, {
    redirect: "manual",
  });
  if (startRes.status !== 307) throw new Error(`start status=${startRes.status}`);
  const stateCookieRaw = (startRes.headers.get("set-cookie") ?? "")
    .match(/keepsake_auth_oauth_state=([^;]+)/)?.[1] ?? "";
  const location = startRes.headers.get("location") ?? "";
  const urlState = new URL(location).searchParams.get("state") ?? "";

  // 2. /callback
  const cbRes = await fetch(
    `${base}/api/auth/google/callback?code=stub-code&state=${encodeURIComponent(urlState)}`,
    {
      redirect: "manual",
      headers: { cookie: `keepsake_auth_oauth_state=${stateCookieRaw}` },
    },
  );

  if (cbRes.status !== 307) {
    const body = await cbRes.text();
    throw new Error(`callback status=${cbRes.status} body=${body.slice(0, 200)}`);
  }
  const setCookie = cbRes.headers.get("set-cookie") ?? "";
  const sessionCookie = setCookie.match(/keepsake_session=([^;]+)/)?.[1] ?? "";
  return { sessionCookie, location: cbRes.headers.get("location") ?? "" };
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
        gmail_account_status, subscription_status
      TO ${appRole}
    `);
    await client.query(`GRANT SELECT ON gmail_accounts TO ${appRole}`);
    await client.query(`GRANT EXECUTE ON FUNCTION current_user_id() TO ${appRole}`);
  });

  const encryptionKey = randomBytes(32).toString("base64");
  const stateSigningSecret = randomBytes(48).toString("base64");
  const sessionSigningSecret = randomBytes(48).toString("base64");

  stub = await startStub();
  process.stdout.write(`stub token endpoint listening on :${stubPort}\n`);

  // Boot Next dev in DB mode. We use the ADMIN URL for both
  // KEEPSAKE_WORKER_DATABASE_URL (workerTransaction requires
  // BYPASSRLS for cross-owner discovery; the users repo also uses
  // workerTransaction) and DATABASE_URL (request path).
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
      KEEPSAKE_DATA_SOURCE: "db",
      NEXT_TELEMETRY_DISABLED: "1",
      APP_SESSION_SIGNING_SECRET: sessionSigningSecret,
      OAUTH_STATE_SIGNING_SECRET: stateSigningSecret,
      KEEPSAKE_AUTH_GOOGLE_CLIENT_ID: "stub-client-id",
      KEEPSAKE_AUTH_GOOGLE_CLIENT_SECRET: "stub-client-secret",
      KEEPSAKE_AUTH_GOOGLE_REDIRECT_URI: "__ORIGIN__/api/auth/google/callback",
      KEEPSAKE_AUTH_GOOGLE_TOKEN_ENDPOINT: `http://127.0.0.1:${stubPort}/token`,
    },
  });
  let serverError = "";
  nextChild.stderr.on("data", (chunk) => { serverError += chunk.toString(); });

  process.stdout.write(`booting next dev on :${port}...\n`);
  await waitForNext();
  process.stdout.write("server ready, running assertions:\n");

  // ── Phase 1: new user is created ──────────────────────────────────
  const firstSignIn = await signIn({ email: "alice@example.test", name: "Alice" });
  check("first sign-in returned a session cookie",
    firstSignIn.sessionCookie.length > 0);
  check("first sign-in redirect lands on returnTo default",
    firstSignIn.location === `${base}/`,
    `location=${firstSignIn.location}`);

  const firstUser = await withClient(adminUrl, async (client) => {
    const r = await client.query(
      `SELECT id::text AS id, email, display_name FROM users WHERE email = $1`,
      ["alice@example.test"],
    );
    return r.rows[0];
  });
  check("users row was created",
    firstUser && typeof firstUser.id === "string" && firstUser.id.length > 0,
    JSON.stringify(firstUser));
  check("users row email matches", firstUser?.email === "alice@example.test");
  check("users row display_name = id token name",
    firstUser?.display_name === "Alice");

  // /api/session with this cookie returns the persisted user.
  const sessionRes = await fetch(`${base}/api/session`, {
    headers: { cookie: `keepsake_session=${firstSignIn.sessionCookie}` },
  });
  const sessionBody = await sessionRes.json();
  check("/api/session with minted cookie -> 200",
    sessionRes.status === 200, `status=${sessionRes.status}`);
  check("/api/session body owner id matches users row",
    sessionBody?.user?.id === firstUser.id);
  check("/api/session body email matches",
    sessionBody?.user?.email === "alice@example.test");
  check("/api/session body name matches",
    sessionBody?.user?.name === "Alice");

  // ── Phase 2: existing user is REUSED ──────────────────────────────
  const usersCountBefore = await withClient(adminUrl, async (client) => {
    const r = await client.query(`SELECT COUNT(*)::int AS n FROM users`);
    return r.rows[0].n;
  });
  const secondSignIn = await signIn({
    email: "alice@example.test",  // same email
    name: "Alice Updated",         // Google sent a different name this time
  });
  check("second sign-in returned a fresh session cookie",
    secondSignIn.sessionCookie.length > 0
      && secondSignIn.sessionCookie !== firstSignIn.sessionCookie);

  const usersCountAfter = await withClient(adminUrl, async (client) => {
    const r = await client.query(`SELECT COUNT(*)::int AS n FROM users`);
    return r.rows[0].n;
  });
  check("users count unchanged (existing user reused)",
    usersCountAfter === usersCountBefore,
    `before=${usersCountBefore} after=${usersCountAfter}`);

  const sessionRes2 = await fetch(`${base}/api/session`, {
    headers: { cookie: `keepsake_session=${secondSignIn.sessionCookie}` },
  });
  const sessionBody2 = await sessionRes2.json();
  check("/api/session after re-sign-in -> 200", sessionRes2.status === 200);
  check("/api/session still returns the same users.id (reuse, no rotation)",
    sessionBody2?.user?.id === firstUser.id,
    `expected=${firstUser.id} got=${sessionBody2?.user?.id}`);
  check("/api/session email unchanged after re-sign-in",
    sessionBody2?.user?.email === "alice@example.test");

  // ── Phase 3: a DIFFERENT email creates a SECOND users row ─────────
  const thirdSignIn = await signIn({ email: "bob@example.test", name: "Bob" });
  check("third sign-in (different email) returned a cookie",
    thirdSignIn.sessionCookie.length > 0);
  const bobUser = await withClient(adminUrl, async (client) => {
    const r = await client.query(
      `SELECT id::text AS id, email FROM users WHERE email = $1`,
      ["bob@example.test"],
    );
    return r.rows[0];
  });
  check("new email created a NEW users row",
    bobUser && bobUser.id !== firstUser.id,
    JSON.stringify(bobUser));
  const finalCount = await withClient(adminUrl, async (client) => {
    const r = await client.query(`SELECT COUNT(*)::int AS n FROM users`);
    return r.rows[0].n;
  });
  check("users count incremented to 2", finalCount === 2,
    `count=${finalCount}`);

  // ── Helper: drive callback with a given id_token + return raw response ─
  // (no expectation that it succeeds — we use this for rejection cases.)
  async function callbackWithIdToken(idToken) {
    rig.nextIdToken = idToken;
    const startRes = await fetch(`${base}/api/auth/google/start`, {
      redirect: "manual",
    });
    if (startRes.status !== 307) throw new Error(`start status=${startRes.status}`);
    const stateCookieRaw = (startRes.headers.get("set-cookie") ?? "")
      .match(/keepsake_auth_oauth_state=([^;]+)/)?.[1] ?? "";
    const urlState = new URL(startRes.headers.get("location") ?? "").searchParams.get("state") ?? "";
    return fetch(
      `${base}/api/auth/google/callback?code=stub-code&state=${encodeURIComponent(urlState)}`,
      {
        redirect: "manual",
        headers: { cookie: `keepsake_auth_oauth_state=${stateCookieRaw}` },
      },
    );
  }

  // ── Phase 4: id_token with email_verified: false -> 400 invalid_callback ─
  process.stdout.write("phase 4 — id_token with email_verified: false is rejected:\n");
  {
    const usersBefore = await withClient(adminUrl, async (client) =>
      (await client.query(`SELECT COUNT(*)::int AS n FROM users`)).rows[0].n);
    // Build an id_token whose payload is { email, name, email_verified: false }
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      email: "unverified@example.test", name: "Unverified",
      email_verified: false,
    })).toString("base64url");
    const res = await callbackWithIdToken(`${header}.${payload}.sig`);
    const body = await res.json().catch(() => null);
    check("email_verified=false -> 400", res.status === 400, `status=${res.status}`);
    check("email_verified=false code=invalid_callback",
      body?.code === "invalid_callback", JSON.stringify(body));
    const setCookie = res.headers.get("set-cookie") ?? "";
    check("email_verified=false does NOT set keepsake_session",
      !setCookie.includes("keepsake_session="), setCookie);
    check("email_verified=false clears the auth state cookie",
      /keepsake_auth_oauth_state=;|Max-Age=0/.test(setCookie));
    const usersAfter = await withClient(adminUrl, async (client) =>
      (await client.query(`SELECT COUNT(*)::int AS n FROM users`)).rows[0].n);
    check("email_verified=false did NOT create a users row",
      usersAfter === usersBefore, `before=${usersBefore} after=${usersAfter}`);
  }

  // ── Phase 5: id_token MISSING email_verified -> 400 invalid_callback ─
  process.stdout.write("phase 5 — id_token missing email_verified is rejected (strict):\n");
  {
    const usersBefore = await withClient(adminUrl, async (client) =>
      (await client.query(`SELECT COUNT(*)::int AS n FROM users`)).rows[0].n);
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    // Note: NO email_verified field at all.
    const payload = Buffer.from(JSON.stringify({
      email: "no-flag@example.test", name: "No Flag",
    })).toString("base64url");
    const res = await callbackWithIdToken(`${header}.${payload}.sig`);
    const body = await res.json().catch(() => null);
    check("email_verified missing -> 400", res.status === 400, `status=${res.status}`);
    check("email_verified missing code=invalid_callback",
      body?.code === "invalid_callback", JSON.stringify(body));
    const setCookie = res.headers.get("set-cookie") ?? "";
    check("email_verified missing does NOT set keepsake_session",
      !setCookie.includes("keepsake_session="), setCookie);
    const usersAfter = await withClient(adminUrl, async (client) =>
      (await client.query(`SELECT COUNT(*)::int AS n FROM users`)).rows[0].n);
    check("email_verified missing did NOT create a users row",
      usersAfter === usersBefore, `before=${usersBefore} after=${usersAfter}`);
  }

  // ── Phase 6: callback success path but APP_SESSION_SIGNING_SECRET missing
  //              -> 501 not_configured (NOT 400 invalid_callback). We
  //              reboot next dev without that env to prove the gate
  //              catches it at the config check rather than mid-flow.
  process.stdout.write("phase 6 — callback without APP_SESSION_SIGNING_SECRET is not_configured:\n");
  await stopNext();
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
      KEEPSAKE_DATA_SOURCE: "db",
      NEXT_TELEMETRY_DISABLED: "1",
      // APP_SESSION_SIGNING_SECRET intentionally unset.
      OAUTH_STATE_SIGNING_SECRET: stateSigningSecret,
      KEEPSAKE_AUTH_GOOGLE_CLIENT_ID: "stub-client-id",
      KEEPSAKE_AUTH_GOOGLE_CLIENT_SECRET: "stub-client-secret",
      KEEPSAKE_AUTH_GOOGLE_REDIRECT_URI: "__ORIGIN__/api/auth/google/callback",
      KEEPSAKE_AUTH_GOOGLE_TOKEN_ENDPOINT: `http://127.0.0.1:${stubPort}/token`,
    },
  });
  nextChild.stderr.on("data", (chunk) => { serverError += chunk.toString(); });
  await waitForNext();
  {
    // start itself should refuse — the same `signInConfig()` check guards
    // both start and callback, so both surfaces stay deterministic.
    const startRes = await fetch(`${base}/api/auth/google/start`, {
      redirect: "manual",
    });
    const startBody = await startRes.json().catch(() => null);
    check("start without session secret -> 501",
      startRes.status === 501, `status=${startRes.status}`);
    check("start without session secret code = not_configured",
      startBody?.code === "not_configured", JSON.stringify(startBody));
    check("start without session secret code is NOT invalid_callback",
      startBody?.code !== "invalid_callback");
    // And the callback path is gated identically.
    const cbRes = await fetch(
      `${base}/api/auth/google/callback?code=stub-code&state=anything`,
      { redirect: "manual" },
    );
    const cbBody = await cbRes.json().catch(() => null);
    check("callback without session secret -> 501",
      cbRes.status === 501, `status=${cbRes.status}`);
    check("callback without session secret code = not_configured",
      cbBody?.code === "not_configured", JSON.stringify(cbBody));
    // Crucially: the user-facing outcome is NOT mis-coded as a callback bug.
    check("callback without session secret code is NOT invalid_callback",
      cbBody?.code !== "invalid_callback");
    // No session cookie was minted.
    const setCookie = cbRes.headers.get("set-cookie") ?? "";
    check("callback without session secret does NOT mint keepsake_session",
      !setCookie.includes("keepsake_session="), setCookie);
  }

  if (serverError && failures.length) {
    process.stdout.write(`\nnext stderr:\n${serverError}\n`);
  }
} catch (error) {
  process.stdout.write(`harness error: ${error?.message ?? error}\n`);
  failures.push("harness");
} finally {
  if (stub) stub.close();
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
  process.stdout.write("\nall /api/auth/google DB checks passed\n");
  process.exit(0);
}
