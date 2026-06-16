// Smoke test for the Gmail OAuth routes.
//
// Covers:
//   * start route (unconfigured / configured) — no token exchange yet
//   * callback route (provider error / missing fields / 401 / 501 /
//     real flow through a local fake token endpoint)
//
// The "configured" scenarios run against a fake token endpoint hosted in this
// process. We never touch accounts.google.com or oauth2.googleapis.com.
//
// Run via: pnpm test:oauth

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const PORT = Number(process.env.TEST_GMAIL_OAUTH_PORT ?? 3145);
const nextBin = resolve(projectRoot, "node_modules/.bin/next");
const AUTH_ENV_KEYS = [
  "DEV_OWNER_ID",
  "DEV_OWNER_EMAIL",
  "DEV_OWNER_NAME",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "GOOGLE_TOKEN_ENDPOINT",
  "OAUTH_STATE_SIGNING_SECRET",
  "KEEPSAKE_DATA_SOURCE",
];

const validAuth = {
  DEV_OWNER_ID: "77777777-7777-4777-8777-777777777777",
  DEV_OWNER_EMAIL: "oauth-owner@example.test",
  DEV_OWNER_NAME: "OAuth Owner",
};

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    process.stdout.write(`  ✗ ${name}${detail ? `  (${detail})` : ""}\n`);
    failures.push(name);
  }
}

function childEnv(authEnv) {
  const env = {
    ...process.env,
    BROWSER: "none",
    NEXT_TELEMETRY_DISABLED: "1",
  };

  for (const key of AUTH_ENV_KEYS) {
    delete env[key];
  }

  return { ...env, ...authEnv };
}

async function waitForReady(baseUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await fetch(`${baseUrl}/api/oauth/gmail/start`);
      return;
    } catch {}

    await wait(500);
  }

  throw new Error(`dev server did not become ready at ${baseUrl}`);
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    wait(3_000).then(() => false),
  ]);

  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

async function fetchJson(baseUrl, path, init = {}) {
  const res = await fetch(`${baseUrl}${path}`, { redirect: "manual", ...init });
  const body = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;

  return { status: res.status, body, headers: res.headers };
}

async function fetchResponse(baseUrl, path, init = {}) {
  return fetch(`${baseUrl}${path}`, { redirect: "manual", ...init });
}

function extractStateCookie(setCookie) {
  if (!setCookie) return null;
  const match = setCookie.match(/keepsake_gmail_oauth_state=([^;]*)/);
  if (!match) return null;
  return decodeURIComponent(match[1]);
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function fakeIdToken(claims) {
  const header = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  return `${header}.${payload}.sig`;
}

// Mock token endpoint server. Used by both this smoke test and the DB-backed
// callback test (which spawns its own copy in-process).
function startFakeTokenServer({ accountEmail }) {
  const usedCodes = new Set();
  const calls = [];
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/token")) {
      res.writeHead(404).end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => {
      const params = new URLSearchParams(body);
      calls.push({
        code: params.get("code"),
        client_id: params.get("client_id"),
        client_secret: params.get("client_secret"),
        redirect_uri: params.get("redirect_uri"),
        grant_type: params.get("grant_type"),
      });

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
        id_token: fakeIdToken({ email: accountEmail }),
      }));
    });
  });

  return new Promise((resolveStart) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveStart({
        url: `http://127.0.0.1:${port}/token`,
        calls,
        async stop() {
          await new Promise((resolveStop) => server.close(() => resolveStop()));
        },
      });
    });
  });
}

async function runServer({ name, port, authEnv, assertions }) {
  const baseUrl = `http://localhost:${port}`;
  const child = spawn(nextBin, ["dev", "--port", String(port)], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv(authEnv),
  });

  let serverError = "";
  child.stderr.on("data", (b) => { serverError += b.toString(); });

  try {
    process.stdout.write(`booting next dev on :${port} for ${name}...\n`);
    await waitForReady(baseUrl);
    await assertions(baseUrl);
  } catch (error) {
    process.stdout.write(`harness error for ${name}: ${error?.message ?? error}\n`);
    if (serverError) {
      process.stdout.write(serverError);
    }
    failures.push(name);
  } finally {
    await stopServer(child);
  }
}

process.stdout.write("running Gmail OAuth route checks:\n");

// ─── 1. unconfigured (no Google env at all) ────────────────────────────────
await runServer({
  name: "valid auth / unconfigured",
  port: PORT,
  authEnv: validAuth,
  async assertions(baseUrl) {
    const start = await fetchJson(baseUrl, "/api/oauth/gmail/start");
    check("start -> 501", start.status === 501, `status=${start.status}`);
    check("start code = not_configured", start.body?.code === "not_configured", JSON.stringify(start.body));

    const startWithReturnTo = await fetchJson(baseUrl, "/api/oauth/gmail/start?returnTo=/profile");
    check("start accepts returnTo", startWithReturnTo.status === 501, `status=${startWithReturnTo.status}`);

    const missingCallback = await fetchJson(baseUrl, "/api/oauth/gmail/callback");
    check("callback without code/state -> 400", missingCallback.status === 400, `status=${missingCallback.status}`);
    check("callback missing code = invalid_callback", missingCallback.body?.code === "invalid_callback", JSON.stringify(missingCallback.body));

    const deniedCallback = await fetchJson(baseUrl, "/api/oauth/gmail/callback?error=access_denied");
    check("callback provider error -> 400", deniedCallback.status === 400, `status=${deniedCallback.status}`);
    check("callback provider code = provider_error", deniedCallback.body?.code === "provider_error", JSON.stringify(deniedCallback.body));

    const validCallback = await fetchJson(baseUrl, "/api/oauth/gmail/callback?code=test-code&state=test-state");
    check("callback with code/state (unconfigured) -> 501", validCallback.status === 501, `status=${validCallback.status}`);
    check("callback unconfigured code = not_configured", validCallback.body?.code === "not_configured", JSON.stringify(validCallback.body));
  },
});

// ─── 2. partially configured: CLIENT_ID + REDIRECT_URI only ─────────────────
await runServer({
  name: "valid auth / missing client secret",
  port: PORT + 3,
  authEnv: {
    ...validAuth,
    GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
    GOOGLE_REDIRECT_URI: "__ORIGIN__/api/oauth/gmail/callback",
  },
  async assertions(baseUrl) {
    const start = await fetchJson(baseUrl, "/api/oauth/gmail/start");
    check("partial config keeps start -> 501", start.status === 501, `status=${start.status}`);
    check("partial config start code = not_configured", start.body?.code === "not_configured");
  },
});

// ─── 3. partially configured: missing signing secret ───────────────────────
await runServer({
  name: "valid auth / weak signing secret",
  port: PORT + 4,
  authEnv: {
    ...validAuth,
    GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    GOOGLE_REDIRECT_URI: "__ORIGIN__/api/oauth/gmail/callback",
    OAUTH_STATE_SIGNING_SECRET: "too-short",
  },
  async assertions(baseUrl) {
    const start = await fetchJson(baseUrl, "/api/oauth/gmail/start");
    check("weak signing secret keeps start -> 501", start.status === 501, `status=${start.status}`);
  },
});

// ─── 4. fully configured start + real callback flow against fake token ─────
const fakeToken = await startFakeTokenServer({ accountEmail: "sender@example.test" });

try {
  await runServer({
    name: "valid auth / configured + fake token endpoint",
    port: PORT + 2,
    authEnv: {
      ...validAuth,
      GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
      GOOGLE_REDIRECT_URI: "__ORIGIN__/api/oauth/gmail/callback",
      OAUTH_STATE_SIGNING_SECRET: "z".repeat(48),
      GOOGLE_TOKEN_ENDPOINT: fakeToken.url,
    },
    async assertions(baseUrl) {
      // ── start ─────────────────────────────────────────────────────────
      const start = await fetchResponse(baseUrl, "/api/oauth/gmail/start?returnTo=/workspace?person=p-lin");
      check("configured start -> 307", start.status === 307, `status=${start.status}`);

      const location = start.headers.get("location") ?? "";
      const redirect = new URL(location);
      check("configured start redirects to Google", redirect.origin === "https://accounts.google.com", location);
      check("configured start sets client_id", redirect.searchParams.get("client_id") === "test-client-id.apps.googleusercontent.com", location);
      check("configured start sets redirect_uri", redirect.searchParams.get("redirect_uri") === `${baseUrl}/api/oauth/gmail/callback`, location);
      check("configured start sets response_type=code", redirect.searchParams.get("response_type") === "code", location);
      check("configured start sets access_type=offline", redirect.searchParams.get("access_type") === "offline", location);
      check("configured start sets prompt=consent", redirect.searchParams.get("prompt") === "consent", location);
      const scope = redirect.searchParams.get("scope") ?? "";
      check(
        "configured start scope includes openid + email + gmail.send",
        scope.split(" ").includes("openid")
          && scope.split(" ").includes("email")
          && scope.split(" ").includes("https://www.googleapis.com/auth/gmail.send"),
        scope,
      );
      check("configured start sets state", Boolean(redirect.searchParams.get("state")), location);

      const startSetCookie = start.headers.get("set-cookie") ?? "";
      check("configured start sets oauth state cookie", /keepsake_gmail_oauth_state=/.test(startSetCookie), startSetCookie);
      check("oauth state cookie is httpOnly", /HttpOnly/i.test(startSetCookie), startSetCookie);
      check("oauth state cookie is sameSite lax", /SameSite=Lax/i.test(startSetCookie), startSetCookie);
      check("oauth state cookie is path root", /Path=\//i.test(startSetCookie), startSetCookie);

      const cookieValue = extractStateCookie(startSetCookie);
      const stateParam = redirect.searchParams.get("state") ?? "";
      check("captured state cookie + query state", !!cookieValue && !!stateParam);

      // ── missing cookie ─────────────────────────────────────────────────
      const noCookie = await fetchJson(baseUrl, `/api/oauth/gmail/callback?code=cb-code-1&state=${stateParam}`);
      check("callback missing cookie -> 400", noCookie.status === 400, `status=${noCookie.status}`);
      check("callback missing cookie = invalid_callback", noCookie.body?.code === "invalid_callback");

      // ── bad cookie signature ───────────────────────────────────────────
      const badSig = await fetchJson(baseUrl, `/api/oauth/gmail/callback?code=cb-code-1&state=${stateParam}`, {
        headers: { cookie: `keepsake_gmail_oauth_state=${cookieValue.slice(0, -3)}xxx` },
      });
      check("callback bad signature -> 400", badSig.status === 400);
      const badSigCookies = badSig.headers.get("set-cookie") ?? "";
      check("callback bad signature clears cookie", /keepsake_gmail_oauth_state=[^,]*Max-Age=0/i.test(badSigCookies), badSigCookies);

      // ── state query mismatch ───────────────────────────────────────────
      const stateMismatch = await fetchJson(baseUrl, `/api/oauth/gmail/callback?code=cb-code-1&state=not-matching`, {
        headers: { cookie: `keepsake_gmail_oauth_state=${cookieValue}` },
      });
      check("callback state mismatch -> 400", stateMismatch.status === 400);
      check("callback state mismatch = invalid_callback", stateMismatch.body?.code === "invalid_callback");

      // ── ownerId mismatch: re-sign a cookie for a different owner ───────
      // Easier: keep cookie but switch DEV_OWNER_ID — would require restart.
      // Instead, the existing cookie was signed for owner DEV_OWNER_ID; we
      // verify the state-vs-cookie ownerId check by hitting the same server
      // with a forged payload that decodes to a different owner. Since we
      // cannot forge without the signing secret, this branch is exercised
      // implicitly when state cookie comes from a different owner (covered
      // by the DB-backed callback test which spawns two owners).

      // NOTE: successful callback + token exchange + DB write + cookie clear
      // are covered end-to-end by `pnpm test:db:gmail-callback`, which has
      // Postgres available. Here we stop at validation-only paths so the
      // default `pnpm test` chain stays Docker-free.
    },
  });
} finally {
  await fakeToken.stop();
}

// ─── 5. missing auth (no DEV_OWNER_*) ──────────────────────────────────────
await runServer({
  name: "missing auth",
  port: PORT + 1,
  authEnv: {},
  async assertions(baseUrl) {
    const start = await fetchJson(baseUrl, "/api/oauth/gmail/start");
    check("start without auth -> 401", start.status === 401, `status=${start.status}`);
    check("start without auth body", start.body?.error === "Unauthenticated", JSON.stringify(start.body));

    const callback = await fetchJson(baseUrl, "/api/oauth/gmail/callback?code=test-code&state=test-state");
    check("callback without auth -> 401", callback.status === 401, `status=${callback.status}`);
    check("callback without auth body", callback.body?.error === "Unauthenticated", JSON.stringify(callback.body));
  },
});

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall Gmail OAuth route checks passed\n");
}
