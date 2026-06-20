// DB-backed smoke test for /api/oauth/gmail/callback.
//
// Boots throwaway Postgres + a fake Google token endpoint in this process,
// starts Next with KEEPSAKE_DATA_SOURCE=db and full OAuth env, then drives
// /api/oauth/gmail/start -> /api/oauth/gmail/callback end-to-end:
//
//   * gmail_accounts row written with encrypted refresh_token_enc
//   * /api/session sendingAccount populated
//   * cookie cleared on success
//   * replay rejected (Google would refuse code reuse)
//   * reconnect rotates refresh_token_enc, scopes update, status stays connected
//
// Run via: pnpm test:db:gmail-callback

import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = normalize(join(__dirname, ".."));
const containerName = `keepsake-test-gmail-callback-db-${Date.now()}`;
const postgresImage = "postgres:17-alpine";
const appRole = "keepsake_app";
const appPassword = "keepsake_app";
const basePort = Number(process.env.TEST_GMAIL_CALLBACK_DB_PORT ?? 3149);

let containerStarted = false;
let nextChild = null;
let fakeToken = null;

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
      else reject(new Error(`${commandName} ${args.join(" ")} failed with exit ${code}\n${stderr || stdout}`));
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

  throw new Error(`Postgres did not become ready: ${lastError?.message ?? "unknown error"}`);
}

async function runSqlFile(databaseUrl, path) {
  const sql = await readFile(join(projectRoot, path), "utf8");
  await withClient(databaseUrl, (client) => client.query(sql));
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function fakeIdToken(claims) {
  const header = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  return `${header}.${payload}.sig`;
}

function startFakeTokenServer({ accountEmail }) {
  const usedCodes = new Set();
  const calls = [];
  let nextEmail = accountEmail;
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/token")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => {
      const params = new URLSearchParams(body);
      calls.push({ code: params.get("code") });
      const code = params.get("code") ?? "";
      if (usedCodes.has(code)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      usedCodes.add(code);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: `access-${code}`,
        refresh_token: `refresh-${code}`,
        expires_in: 3599,
        scope: "openid email https://www.googleapis.com/auth/gmail.send",
        token_type: "Bearer",
        id_token: fakeIdToken({ email: nextEmail }),
      }));
    });
  });
  return new Promise((resolveStart) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveStart({
        url: `http://127.0.0.1:${port}/token`,
        calls,
        setEmail(email) { nextEmail = email; },
        async stop() {
          await new Promise((resolveStop) => server.close(() => resolveStop()));
        },
      });
    });
  });
}

async function waitForNext(base) {
  const deadline = Date.now() + 60_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/session`);
      if (res.status < 500) return;
      lastError = new Error(`status ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(500);
  }
  throw new Error(`Next dev did not become ready at ${base}: ${lastError?.message ?? "unknown error"}`);
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

function decryptRefreshToken({ ownerId, blob, keyBase64 }) {
  const key = Buffer.from(keyBase64, "base64");
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(12, blob.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(`${ownerId}|gmail_accounts|refresh_token_enc`, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

async function mintDevSession(base) {
  // POST /api/auth/dev-session/start mints a real `keepsake_session`
  // cookie for the DEV_OWNER_* identity. P6-C made /profile cookie-
  // only, so every page fetch in this smoke must carry it. The route
  // is gated behind ENABLE_DEV_SESSION_ROUTES=1 (set in the next-dev
  // env below).
  const res = await fetch(`${base}/api/auth/dev-session/start`, {
    method: "POST",
  });
  if (res.status !== 200) {
    throw new Error(`dev-session/start failed: status=${res.status}`);
  }
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.match(/keepsake_session=([^;]+)/)?.[1] ?? "";
  if (!cookie) {
    throw new Error("dev-session/start did not return a keepsake_session cookie");
  }
  return cookie;
}

function normalizeHtml(html) {
  // React stitches text around interpolated values with `<!-- -->`
  // sentinels and encodes apostrophes in attributes. Normalise both
  // so substring assertions match what a reader of the page sees.
  return html
    .replace(/<!--\s*-->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractStateCookie(setCookie) {
  if (!setCookie) return null;
  const match = setCookie.match(/keepsake_gmail_oauth_state=([^;]*)/);
  if (!match) return null;
  return decodeURIComponent(match[1]);
}

function isClearCookie(setCookie) {
  // Set-Cookie headers from fetch are joined by ', ' between cookies; within
  // one cookie, attributes are ;-separated. Match the keepsake cookie name
  // followed by Max-Age=0 within the same Set-Cookie record.
  return /keepsake_gmail_oauth_state=[^,]*Max-Age=0/i.test(setCookie ?? "");
}

const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
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
  const ownerEmail = "callback-owner@example.test";
  const ownerName = "Callback Owner";
  const encryptionKey = randomBytes(32).toString("base64");
  const signingSecret = randomBytes(48).toString("base64");
  const senderEmail = "sender@example.test";

  await withClient(adminUrl, async (client) => {
    await client.query(
      `INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`,
      [ownerId, ownerEmail, ownerName],
    );
  });

  fakeToken = await startFakeTokenServer({ accountEmail: senderEmail });

  const port = basePort;
  const base = `http://localhost:${port}`;
  const nextBin = resolve(projectRoot, "node_modules/.bin/next");
  nextChild = spawn(nextBin, ["dev", "--port", String(port)], {
    cwd: projectRoot,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      BROWSER: "none",
      DATABASE_URL: appUrl,
      DEV_ENCRYPTION_KEY_BASE64: encryptionKey,
      DEV_OWNER_ID: ownerId,
      DEV_OWNER_EMAIL: ownerEmail,
      DEV_OWNER_NAME: ownerName,
      KEEPSAKE_DATA_SOURCE: "db",
      NEXT_TELEMETRY_DISABLED: "1",
      GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
      GOOGLE_REDIRECT_URI: "__ORIGIN__/api/oauth/gmail/callback",
      GOOGLE_TOKEN_ENDPOINT: fakeToken.url,
      OAUTH_STATE_SIGNING_SECRET: signingSecret,
      // P6-C: /profile is cookie-only now. We mint a real session
      // below via /api/auth/dev-session/start (gated behind
      // ENABLE_DEV_SESSION_ROUTES=1) and thread the cookie through
      // every page + OAuth fetch in this smoke.
      APP_SESSION_SIGNING_SECRET:
        "test-gmail-oauth-callback-db-app-session-secret-min-32-chars",
      ENABLE_DEV_SESSION_ROUTES: "1",
    },
  });

  let serverError = "";
  nextChild.stderr.on("data", (chunk) => { serverError += chunk.toString(); });

  process.stdout.write(`booting next dev on :${port}...\n`);
  await waitForNext(base);
  const sessionCookie = await mintDevSession(base);
  process.stdout.write("server ready, running assertions:\n");

  // 1. start → capture cookie + state
  const start = await fetch(`${base}/api/oauth/gmail/start?returnTo=/profile`, {
    redirect: "manual",
    headers: { cookie: `keepsake_session=${sessionCookie}` },
  });
  check("start -> 307", start.status === 307, `status=${start.status}`);
  const startCookie = extractStateCookie(start.headers.get("set-cookie"));
  const stateParam = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  check("captured start cookie", !!startCookie);
  check("captured start state", !!stateParam);

  // 2. successful callback
  const success = await fetch(
    `${base}/api/oauth/gmail/callback?code=cb-1&state=${stateParam}`,
    {
      redirect: "manual",
      headers: {
        cookie: `keepsake_session=${sessionCookie}; keepsake_gmail_oauth_state=${startCookie}`,
      },
    },
  );
  check("successful callback -> 307", success.status === 307, `status=${success.status}`);
  const successLocation = new URL(success.headers.get("location") ?? "");
  check("successful callback redirects to /profile", successLocation.pathname === "/profile", successLocation.toString());
  check("successful callback clears state cookie", isClearCookie(success.headers.get("set-cookie")));

  // 3. DB inspection: one primary gmail_accounts row, encrypted refresh_token_enc
  const accountRows = await withClient(adminUrl, async (client) => {
    const result = await client.query(
      `
        SELECT id::text AS id, email::text AS email, status, is_primary,
               scopes, refresh_token_enc, last_error
        FROM gmail_accounts
        WHERE owner_id = $1
      `,
      [ownerId],
    );
    return result.rows;
  });

  check("one gmail_accounts row exists", accountRows.length === 1, `rows=${accountRows.length}`);
  check("gmail_accounts.email = sender", accountRows[0]?.email === senderEmail, accountRows[0]?.email);
  check("gmail_accounts.status = connected", accountRows[0]?.status === "connected");
  check("gmail_accounts.is_primary = true", accountRows[0]?.is_primary === true);
  check("gmail_accounts.scopes includes gmail.send", Array.isArray(accountRows[0]?.scopes) && accountRows[0].scopes.includes("https://www.googleapis.com/auth/gmail.send"));
  check("gmail_accounts.scopes includes openid+email", accountRows[0]?.scopes.includes("openid") && accountRows[0]?.scopes.includes("email"));

  const refreshBlob = accountRows[0]?.refresh_token_enc;
  check("refresh_token_enc is bytea", refreshBlob instanceof Buffer);
  check(
    "refresh_token_enc is not plaintext",
    !refreshBlob.toString("utf8").includes("refresh-cb-1"),
  );
  const decrypted = decryptRefreshToken({ ownerId, blob: refreshBlob, keyBase64: encryptionKey });
  check("refresh_token_enc decrypts to fake server's refresh token", decrypted === "refresh-cb-1");

  // 4. /api/session sees the connected sendingAccount
  const sessionRes = await fetch(`${base}/api/session`, {
    headers: { cookie: `keepsake_session=${sessionCookie}` },
  });
  const sessionBody = await sessionRes.json();
  check("/api/session -> 200", sessionRes.status === 200, `status=${sessionRes.status}`);
  check(
    "/api/session sendingAccount.email = sender",
    sessionBody?.user?.sendingAccount?.email === senderEmail,
    JSON.stringify(sessionBody),
  );
  check(
    "/api/session sendingAccount.status = connected",
    sessionBody?.user?.sendingAccount?.status === "connected",
  );
  check(
    "/api/session sendingAccount.provider = gmail",
    sessionBody?.user?.sendingAccount?.provider === "gmail",
  );

  // 5. Profile renders sender email (proves UI consumer sees DB row)
  const profileRes = await fetch(`${base}/profile`, {
    headers: { cookie: `keepsake_session=${sessionCookie}` },
  });
  const profileBody = normalizeHtml(await profileRes.text());
  check("/profile -> 200", profileRes.status === 200);
  check("/profile renders sender email", profileBody.includes(`Emails send from ${senderEmail}`));
  check("/profile renders Connected", profileBody.includes("Connected"));

  // 6. Replay attack: reuse the (now-cleared) cookie + same code
  const replay = await fetch(
    `${base}/api/oauth/gmail/callback?code=cb-1&state=${stateParam}`,
    {
      redirect: "manual",
      headers: {
        cookie: `keepsake_session=${sessionCookie}; keepsake_gmail_oauth_state=${startCookie}`,
      },
    },
  );
  const replayBody = replay.headers.get("content-type")?.includes("json") ? await replay.json() : null;
  check("replay -> 400", replay.status === 400, `status=${replay.status}`);
  check("replay = invalid_callback", replayBody?.code === "invalid_callback");

  // Replay must not have created or duplicated rows.
  const afterReplay = await withClient(adminUrl, async (client) => {
    const result = await client.query(
      `SELECT count(*)::int AS n FROM gmail_accounts WHERE owner_id = $1`,
      [ownerId],
    );
    return result.rows[0]?.n;
  });
  check("replay leaves only one gmail_accounts row", afterReplay === 1, `rows=${afterReplay}`);

  // 7. Reconnect (fresh start → fresh callback for the same Gmail address):
  //    - same email so ON CONFLICT path runs
  //    - refresh_token_enc rotates to the new ciphertext
  //    - row count stays at one
  const start2 = await fetch(`${base}/api/oauth/gmail/start?returnTo=/profile`, {
    redirect: "manual",
    headers: { cookie: `keepsake_session=${sessionCookie}` },
  });
  const cookie2 = extractStateCookie(start2.headers.get("set-cookie"));
  const state2 = new URL(start2.headers.get("location") ?? "").searchParams.get("state");

  const success2 = await fetch(
    `${base}/api/oauth/gmail/callback?code=cb-2&state=${state2}`,
    {
      redirect: "manual",
      headers: {
        cookie: `keepsake_session=${sessionCookie}; keepsake_gmail_oauth_state=${cookie2}`,
      },
    },
  );
  check("reconnect callback -> 307", success2.status === 307, `status=${success2.status}`);

  const afterReconnect = await withClient(adminUrl, async (client) => {
    const result = await client.query(
      `
        SELECT id::text AS id, refresh_token_enc
        FROM gmail_accounts
        WHERE owner_id = $1
      `,
      [ownerId],
    );
    return result.rows;
  });
  check("reconnect keeps row count at 1", afterReconnect.length === 1, `rows=${afterReconnect.length}`);
  check("reconnect keeps account id", afterReconnect[0]?.id === accountRows[0]?.id);
  const rotated = decryptRefreshToken({
    ownerId,
    blob: afterReconnect[0]?.refresh_token_enc,
    keyBase64: encryptionKey,
  });
  check("reconnect rotates refresh_token_enc", rotated === "refresh-cb-2");

  // 8. Token endpoint was hit three times: success(cb-1), replay(cb-1) where the
  //    provider returns invalid_grant, and reconnect(cb-2). Order doesn't matter,
  //    only that nothing extra happened.
  check("token endpoint called three times in total", fakeToken.calls.length === 3, `calls=${fakeToken.calls.length}`);
  const codes = fakeToken.calls.map((c) => c.code);
  check("token endpoint codes covered cb-1 + cb-2 only", new Set(codes).size === 2 && codes.includes("cb-1") && codes.includes("cb-2"), JSON.stringify(codes));
} catch (error) {
  process.stdout.write(`harness error: ${error?.message ?? error}\n`);
  if (nextChild) {
    nextChild.stderr.removeAllListeners("data");
  }
  failures.push("harness");
} finally {
  await stopNext();
  if (fakeToken) await fakeToken.stop();
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
  process.stdout.write("\nall Gmail OAuth callback DB checks passed\n");
  process.exit(0);
}
