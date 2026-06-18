// Default smoke for the Google sign-in route layer. No Docker.
// Stubs Google's token endpoint locally; never touches the real
// network.
//
// This test covers:
//   * GET /api/auth/google/start
//       - not configured → 501 not_configured
//       - configured     → 307 to Google with the right query params
//   * GET /api/auth/google/callback
//       - provider denied         → 400 provider_error
//       - missing state cookie    → 400 invalid_callback
//       - state mismatch          → 400 invalid_callback
//       - data-source != db       → 501 not_configured (with state cleared)
//
// The "happy path" + users row create/reuse lives in the DB harness
// (`test-google-signin-db.mjs`) because it needs Postgres.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const BASE_PORT = Number(process.env.TEST_GOOGLE_SIGNIN_PORT ?? 3146);
const STUB_PORT = Number(process.env.TEST_GOOGLE_SIGNIN_STUB_PORT ?? 3185);
const nextBin = resolve(projectRoot, "node_modules/.bin/next");
const VALID_SECRET = "test-google-signin-state-signing-secret-32+chars";

const ENV_KEYS = [
  "DEV_OWNER_ID",
  "DEV_OWNER_EMAIL",
  "DEV_OWNER_NAME",
  "DATABASE_URL",
  "KEEPSAKE_DATA_SOURCE",
  "APP_SESSION_SIGNING_SECRET",
  "OAUTH_STATE_SIGNING_SECRET",
  "ENABLE_DEV_SESSION_ROUTES",
  "KEEPSAKE_AUTH_GOOGLE_CLIENT_ID",
  "KEEPSAKE_AUTH_GOOGLE_CLIENT_SECRET",
  "KEEPSAKE_AUTH_GOOGLE_REDIRECT_URI",
  "KEEPSAKE_AUTH_GOOGLE_AUTH_URL",
  "KEEPSAKE_AUTH_GOOGLE_TOKEN_ENDPOINT",
];

const failures = [];
function check(name, cond, detail = "") {
  if (cond) process.stdout.write(`  ✓ ${name}\n`);
  else {
    process.stdout.write(`  ✗ ${name}${detail ? `  (${detail})` : ""}\n`);
    failures.push(name);
  }
}

function childEnv(extra) {
  const env = {
    ...process.env,
    BROWSER: "none",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  for (const key of ENV_KEYS) delete env[key];
  return { ...env, ...extra };
}

async function waitForReady(baseUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/api/session`);
      if (r.status < 500) return;
    } catch {}
    await wait(500);
  }
  throw new Error(`dev server did not become ready at ${baseUrl}`);
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((r) => child.once("exit", () => r(true))),
    wait(3_000).then(() => false),
  ]);
  if (!exited) child.kill("SIGKILL");
}

const rig = {
  tokenCalls: [],
  nextResponse: null,
};
function startStub() {
  return new Promise((resolveStarted, reject) => {
    const server = createServer((req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 404;
        res.end();
        return;
      }
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        rig.tokenCalls.push({ url: req.url, body });
        const r = rig.nextResponse ?? { status: 200, body: { id_token: makeIdToken() } };
        rig.nextResponse = null;
        res.statusCode = r.status;
        res.setHeader("content-type", "application/json");
        res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
      });
    });
    server.on("error", reject);
    server.listen(STUB_PORT, "127.0.0.1", () => resolveStarted(server));
  });
}

function makeIdToken({ email = "stub@example.test", name = "Stub User", emailVerified = true } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    email, name, email_verified: emailVerified,
  })).toString("base64url");
  return `${header}.${payload}.sig`;
}

async function runPhase({ name, port, env, run }) {
  const baseUrl = `http://localhost:${port}`;
  const child = spawn(nextBin, ["dev", "--port", String(port)], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv(env),
  });
  let serverError = "";
  child.stderr.on("data", (b) => { serverError += b.toString(); });
  try {
    process.stdout.write(`booting next dev on :${port} for ${name}...\n`);
    await waitForReady(baseUrl);
    await run(baseUrl);
  } catch (error) {
    process.stdout.write(`harness error for ${name}: ${error?.message ?? error}\n`);
    if (serverError) process.stdout.write(serverError);
    failures.push(name);
  } finally {
    await stopServer(child);
  }
}

const stub = await startStub();
process.stdout.write(`stub provider listening on :${STUB_PORT}\n`);

try {
  // ── Phase 1: start route — not configured ─────────────────────────
  await runPhase({
    name: "start: not configured",
    port: BASE_PORT,
    env: {
      // No KEEPSAKE_AUTH_GOOGLE_CLIENT_ID etc.
      OAUTH_STATE_SIGNING_SECRET: VALID_SECRET,
      APP_SESSION_SIGNING_SECRET: VALID_SECRET,
    },
    async run(baseUrl) {
      const res = await fetch(`${baseUrl}/api/auth/google/start`, {
        redirect: "manual",
      });
      const body = await res.json().catch(() => null);
      check("start unconfigured -> 501",
        res.status === 501, `status=${res.status}`);
      check("start unconfigured body code = not_configured",
        body?.code === "not_configured", JSON.stringify(body));
    },
  });

  // ── Phase 2: start route — configured, redirects ──────────────────
  await runPhase({
    name: "start: configured",
    port: BASE_PORT + 1,
    env: {
      KEEPSAKE_AUTH_GOOGLE_CLIENT_ID: "stub-client-id",
      KEEPSAKE_AUTH_GOOGLE_CLIENT_SECRET: "stub-client-secret",
      KEEPSAKE_AUTH_GOOGLE_REDIRECT_URI: "__ORIGIN__/api/auth/google/callback",
      KEEPSAKE_AUTH_GOOGLE_AUTH_URL: "https://example-google.test/o/oauth2/v2/auth",
      OAUTH_STATE_SIGNING_SECRET: VALID_SECRET,
      APP_SESSION_SIGNING_SECRET: VALID_SECRET,
    },
    async run(baseUrl) {
      const res = await fetch(`${baseUrl}/api/auth/google/start`, {
        redirect: "manual",
      });
      check("start configured -> 307", res.status === 307,
        `status=${res.status}`);
      const location = res.headers.get("location") ?? "";
      check("start redirects to the configured authorization URL",
        location.startsWith("https://example-google.test/o/oauth2/v2/auth?"),
        location.slice(0, 80));
      const parsed = new URL(location);
      check("redirect includes client_id",
        parsed.searchParams.get("client_id") === "stub-client-id");
      check("redirect scope = openid email profile",
        parsed.searchParams.get("scope") === "openid email profile");
      check("redirect requests response_type=code",
        parsed.searchParams.get("response_type") === "code");
      check("redirect carries a non-empty state",
        (parsed.searchParams.get("state") ?? "").length > 0);
      check("redirect uses origin-bound callback uri",
        parsed.searchParams.get("redirect_uri") === `${baseUrl}/api/auth/google/callback`);

      const setCookie = res.headers.get("set-cookie") ?? "";
      check("start sets the auth state cookie",
        /keepsake_auth_oauth_state=/.test(setCookie),
        setCookie.slice(0, 120));
    },
  });

  // ── Phase 3: callback — provider denied ──────────────────────────
  await runPhase({
    name: "callback: provider denied",
    port: BASE_PORT + 2,
    env: {
      KEEPSAKE_AUTH_GOOGLE_CLIENT_ID: "stub-client-id",
      KEEPSAKE_AUTH_GOOGLE_CLIENT_SECRET: "stub-client-secret",
      KEEPSAKE_AUTH_GOOGLE_REDIRECT_URI: "__ORIGIN__/api/auth/google/callback",
      KEEPSAKE_AUTH_GOOGLE_TOKEN_ENDPOINT: `http://127.0.0.1:${STUB_PORT}/token`,
      OAUTH_STATE_SIGNING_SECRET: VALID_SECRET,
      APP_SESSION_SIGNING_SECRET: VALID_SECRET,
    },
    async run(baseUrl) {
      const res = await fetch(
        `${baseUrl}/api/auth/google/callback?error=access_denied`,
        { redirect: "manual" },
      );
      const body = await res.json().catch(() => null);
      check("callback provider denied -> 400",
        res.status === 400, `status=${res.status}`);
      check("callback provider denied code = provider_error",
        body?.code === "provider_error", JSON.stringify(body));
      const setCookie = res.headers.get("set-cookie") ?? "";
      check("callback clears the state cookie",
        /keepsake_auth_oauth_state=;|Max-Age=0/.test(setCookie),
        setCookie);
    },
  });

  // ── Phase 4: callback — missing state cookie ─────────────────────
  await runPhase({
    name: "callback: missing state cookie",
    port: BASE_PORT + 3,
    env: {
      KEEPSAKE_AUTH_GOOGLE_CLIENT_ID: "stub-client-id",
      KEEPSAKE_AUTH_GOOGLE_CLIENT_SECRET: "stub-client-secret",
      KEEPSAKE_AUTH_GOOGLE_REDIRECT_URI: "__ORIGIN__/api/auth/google/callback",
      KEEPSAKE_AUTH_GOOGLE_TOKEN_ENDPOINT: `http://127.0.0.1:${STUB_PORT}/token`,
      OAUTH_STATE_SIGNING_SECRET: VALID_SECRET,
      APP_SESSION_SIGNING_SECRET: VALID_SECRET,
    },
    async run(baseUrl) {
      const res = await fetch(
        `${baseUrl}/api/auth/google/callback?code=stub&state=irrelevant`,
        { redirect: "manual" },
      );
      const body = await res.json().catch(() => null);
      check("callback missing state cookie -> 400",
        res.status === 400, `status=${res.status}`);
      check("callback missing state cookie code = invalid_callback",
        body?.code === "invalid_callback", JSON.stringify(body));
    },
  });

  // ── Phase 5: callback — state mismatch ───────────────────────────
  // Synthesise a real state cookie via /start, then send a different
  // state in the URL.
  await runPhase({
    name: "callback: state mismatch",
    port: BASE_PORT + 4,
    env: {
      KEEPSAKE_AUTH_GOOGLE_CLIENT_ID: "stub-client-id",
      KEEPSAKE_AUTH_GOOGLE_CLIENT_SECRET: "stub-client-secret",
      KEEPSAKE_AUTH_GOOGLE_REDIRECT_URI: "__ORIGIN__/api/auth/google/callback",
      KEEPSAKE_AUTH_GOOGLE_TOKEN_ENDPOINT: `http://127.0.0.1:${STUB_PORT}/token`,
      OAUTH_STATE_SIGNING_SECRET: VALID_SECRET,
      APP_SESSION_SIGNING_SECRET: VALID_SECRET,
    },
    async run(baseUrl) {
      const startRes = await fetch(`${baseUrl}/api/auth/google/start`, {
        redirect: "manual",
      });
      const stateCookie = (startRes.headers.get("set-cookie") ?? "")
        .match(/keepsake_auth_oauth_state=([^;]+)/)?.[1] ?? "";
      check("start emitted the state cookie", stateCookie.length > 0);

      const res = await fetch(
        `${baseUrl}/api/auth/google/callback?code=stub&state=WRONG_STATE`,
        {
          redirect: "manual",
          headers: { cookie: `keepsake_auth_oauth_state=${stateCookie}` },
        },
      );
      const body = await res.json().catch(() => null);
      check("callback state mismatch -> 400",
        res.status === 400, `status=${res.status}`);
      check("callback state mismatch code = invalid_callback",
        body?.code === "invalid_callback", JSON.stringify(body));
    },
  });

  // ── Phase 5b: start with full OAuth env but missing APP_SESSION_SIGNING_SECRET
  //              → 501 not_configured. (Session-cookie minting is part
  //               of the sign-in config surface; we won't even start a
  //               flow we can't complete.)
  await runPhase({
    name: "start: missing APP_SESSION_SIGNING_SECRET",
    port: BASE_PORT + 6,
    env: {
      KEEPSAKE_AUTH_GOOGLE_CLIENT_ID: "stub-client-id",
      KEEPSAKE_AUTH_GOOGLE_CLIENT_SECRET: "stub-client-secret",
      KEEPSAKE_AUTH_GOOGLE_REDIRECT_URI: "__ORIGIN__/api/auth/google/callback",
      OAUTH_STATE_SIGNING_SECRET: VALID_SECRET,
      // APP_SESSION_SIGNING_SECRET intentionally unset.
    },
    async run(baseUrl) {
      const res = await fetch(`${baseUrl}/api/auth/google/start`, {
        redirect: "manual",
      });
      const body = await res.json().catch(() => null);
      check("start without session secret -> 501",
        res.status === 501, `status=${res.status}`);
      check("start without session secret code = not_configured",
        body?.code === "not_configured", JSON.stringify(body));
      // Critical regression guard: this MUST NOT be invalid_callback.
      check("start without session secret code is NOT invalid_callback",
        body?.code !== "invalid_callback");
    },
  });

  // ── Phase 6: callback — mock data source rejects (no DB) ─────────
  // With valid state but KEEPSAKE_DATA_SOURCE unset, sign-in completion
  // returns 501 not_configured (we can't persist a users row in mock).
  await runPhase({
    name: "callback: data source != db",
    port: BASE_PORT + 5,
    env: {
      KEEPSAKE_AUTH_GOOGLE_CLIENT_ID: "stub-client-id",
      KEEPSAKE_AUTH_GOOGLE_CLIENT_SECRET: "stub-client-secret",
      KEEPSAKE_AUTH_GOOGLE_REDIRECT_URI: "__ORIGIN__/api/auth/google/callback",
      KEEPSAKE_AUTH_GOOGLE_TOKEN_ENDPOINT: `http://127.0.0.1:${STUB_PORT}/token`,
      OAUTH_STATE_SIGNING_SECRET: VALID_SECRET,
      APP_SESSION_SIGNING_SECRET: VALID_SECRET,
      KEEPSAKE_DATA_SOURCE: "mock",
    },
    async run(baseUrl) {
      // Synthesise a valid state cookie + matching URL state.
      const startRes = await fetch(`${baseUrl}/api/auth/google/start`, {
        redirect: "manual",
      });
      const stateCookie = (startRes.headers.get("set-cookie") ?? "")
        .match(/keepsake_auth_oauth_state=([^;]+)/)?.[1] ?? "";
      const location = startRes.headers.get("location") ?? "";
      const urlState = new URL(location).searchParams.get("state") ?? "";

      const res = await fetch(
        `${baseUrl}/api/auth/google/callback?code=stub&state=${encodeURIComponent(urlState)}`,
        {
          redirect: "manual",
          headers: { cookie: `keepsake_auth_oauth_state=${stateCookie}` },
        },
      );
      const body = await res.json().catch(() => null);
      check("callback mock-mode -> 501",
        res.status === 501, `status=${res.status}`);
      check("callback mock-mode code = not_configured",
        body?.code === "not_configured", JSON.stringify(body));
      const setCookie = res.headers.get("set-cookie") ?? "";
      check("callback mock-mode still clears the state cookie",
        /keepsake_auth_oauth_state=;|Max-Age=0/.test(setCookie), setCookie);
    },
  });
} finally {
  stub.close();
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall /api/auth/google smoke checks passed\n");
}
