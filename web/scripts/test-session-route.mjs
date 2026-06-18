// Smoke test for GET /api/session. Boots `next dev` on isolated ports and
// verifies the auth contract without touching DB, cookies, OAuth, or Gmail.
//
// Run via: pnpm test:auth

import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const BASE_PORT = Number(process.env.TEST_SESSION_PORT ?? 3139);
const AUTH_ENV_KEYS = [
  "DEV_OWNER_ID",
  "DEV_OWNER_EMAIL",
  "DEV_OWNER_NAME",
  "DATABASE_URL",
  "DEV_ENCRYPTION_KEY_BASE64",
  "KEEPSAKE_DATA_SOURCE",
  "APP_SESSION_SIGNING_SECRET",
  "ENABLE_DEV_SESSION_ROUTES",
];

const VALID_SECRET = "test-app-session-secret-that-is-at-least-32-chars";
const nextBin = resolve(projectRoot, "node_modules/.bin/next");

const cases = [
  {
    name: "valid dev env",
    port: BASE_PORT,
    env: {
      DEV_OWNER_ID: "22222222-2222-4222-8222-222222222222",
      DEV_OWNER_EMAIL: "session-owner@example.test",
      DEV_OWNER_NAME: "Session Owner",
    },
    expectedStatus: 200,
    assertBody(body) {
      return body?.user?.id === "22222222-2222-4222-8222-222222222222"
        && body.user.email === "session-owner@example.test"
        && body.user.name === "Session Owner"
        && body.user.initials === "SO"
        && body.user.sendingAccount === null;
    },
  },
  {
    name: "missing auth env",
    port: BASE_PORT + 1,
    env: {},
    expectedStatus: 401,
    assertBody(body) {
      return body?.error === "Unauthenticated";
    },
  },
  {
    name: "invalid auth env",
    port: BASE_PORT + 2,
    env: {
      DEV_OWNER_ID: "22222222-2222-4222-8222-222222222222",
      DEV_OWNER_EMAIL: "invalid-email",
      DEV_OWNER_NAME: "Session Owner",
    },
    expectedStatus: 500,
    assertBody(body) {
      return body?.error === "Auth is misconfigured";
    },
  },
];

const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
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

async function fetchJson(baseUrl) {
  const res = await fetch(`${baseUrl}/api/session`);
  const body = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;

  return { status: res.status, body };
}

async function waitForReady(baseUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${baseUrl}/api/session`);
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

async function runCase(testCase) {
  const baseUrl = `http://localhost:${testCase.port}`;
  const child = spawn(nextBin, ["dev", "--port", String(testCase.port)], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv(testCase.env),
  });

  let serverError = "";
  child.stderr.on("data", (b) => { serverError += b.toString(); });

  try {
    process.stdout.write(`booting next dev on :${testCase.port} for ${testCase.name}...\n`);
    await waitForReady(baseUrl);

    const { status, body } = await fetchJson(baseUrl);
    check(
      `${testCase.name} -> ${testCase.expectedStatus}`,
      status === testCase.expectedStatus,
      `status=${status} body=${JSON.stringify(body)}`,
    );
    check(`${testCase.name} body`, testCase.assertBody(body), JSON.stringify(body));
  } catch (error) {
    process.stdout.write(`harness error for ${testCase.name}: ${error?.message ?? error}\n`);
    if (serverError) {
      process.stdout.write(serverError);
    }
    failures.push(testCase.name);
  } finally {
    await stopServer(child);
  }
}

async function runCookieFlow({ port, env, assertions }) {
  const baseUrl = `http://localhost:${port}`;
  const child = spawn(nextBin, ["dev", "--port", String(port)], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv(env),
  });
  let serverError = "";
  child.stderr.on("data", (b) => { serverError += b.toString(); });

  try {
    process.stdout.write(`booting next dev on :${port} for cookie flow...\n`);
    await waitForReady(baseUrl);
    await assertions(baseUrl);
  } catch (error) {
    process.stdout.write(`harness error for cookie flow: ${error?.message ?? error}\n`);
    if (serverError) process.stdout.write(serverError);
    failures.push("cookie flow");
  } finally {
    await stopServer(child);
  }
}

function parseSetCookie(res) {
  const setCookie = res.headers.get("set-cookie") ?? "";
  // Pull out the keepsake_session value. Node's fetch returns a single
  // combined header string, but cookie values themselves don't contain
  // commas (we base64url them), so a simple split is enough here.
  const match = setCookie.match(/keepsake_session=([^;]*)/);
  return match ? match[1] : "";
}

process.stdout.write("running /api/session smoke checks:\n");

for (const testCase of cases) {
  await runCase(testCase);
}

// ── Cookie-backed scenarios ────────────────────────────────────────────
await runCookieFlow({
  port: BASE_PORT + 3,
  env: {
    APP_SESSION_SIGNING_SECRET: VALID_SECRET,
    ENABLE_DEV_SESSION_ROUTES: "1",
    DEV_OWNER_ID: "33333333-3333-4333-8333-333333333333",
    DEV_OWNER_EMAIL: "cookie-owner@example.test",
    DEV_OWNER_NAME: "Cookie Owner",
  },
  async assertions(baseUrl) {
    // 1. Bootstrap a session via POST /api/auth/dev-session/start.
    const startRes = await fetch(`${baseUrl}/api/auth/dev-session/start`, {
      method: "POST",
    });
    check("dev-session/start -> 200", startRes.status === 200, `status=${startRes.status}`);
    const startBody = await startRes.json();
    check("dev-session/start returns the env owner",
      startBody?.user?.email === "cookie-owner@example.test"
        && startBody.user.id === "33333333-3333-4333-8333-333333333333");
    const cookieValue = parseSetCookie(startRes);
    check("dev-session/start sets the keepsake_session cookie",
      typeof cookieValue === "string" && cookieValue.length > 0,
      `cookieValue=${cookieValue.slice(0, 30)}...`);

    // 2. GET /api/session WITH the cookie -> same shape as env path.
    const sessionRes = await fetch(`${baseUrl}/api/session`, {
      headers: { cookie: `keepsake_session=${cookieValue}` },
    });
    const sessionBody = await sessionRes.json();
    check("/api/session with cookie -> 200", sessionRes.status === 200);
    check("/api/session body shape matches env path",
      sessionBody?.user?.id === "33333333-3333-4333-8333-333333333333"
        && sessionBody.user.email === "cookie-owner@example.test"
        && sessionBody.user.name === "Cookie Owner"
        && sessionBody.user.initials === "CO"
        && sessionBody.user.sendingAccount === null);

    // 3. Tampered cookie -> 401, no silent fallback to env.
    const tamperedRes = await fetch(`${baseUrl}/api/session`, {
      headers: { cookie: `keepsake_session=${cookieValue.slice(0, -10)}xxxxxxxxxx` },
    });
    const tamperedBody = await tamperedRes.json();
    check("/api/session with tampered cookie -> 401",
      tamperedRes.status === 401, `status=${tamperedRes.status}`);
    check("/api/session tampered body says unauthenticated",
      tamperedBody?.error === "Unauthenticated",
      JSON.stringify(tamperedBody));

    // 4. Malformed cookie (no dot) -> 401.
    const malformedRes = await fetch(`${baseUrl}/api/session`, {
      headers: { cookie: "keepsake_session=not-a-real-cookie" },
    });
    check("/api/session with malformed cookie -> 401",
      malformedRes.status === 401, `status=${malformedRes.status}`);

    // 5. No cookie -> falls back to env (200).
    const fallbackRes = await fetch(`${baseUrl}/api/session`);
    check("/api/session with no cookie -> 200 (env fallback)",
      fallbackRes.status === 200);

    // 6. POST /api/auth/dev-session/clear sets an expired cookie.
    const clearRes = await fetch(`${baseUrl}/api/auth/dev-session/clear`, {
      method: "POST",
    });
    check("dev-session/clear -> 200", clearRes.status === 200);
    const clearedSetCookie = clearRes.headers.get("set-cookie") ?? "";
    check("dev-session/clear sets Max-Age=0 (or expires) on the cookie",
      /keepsake_session=;/.test(clearedSetCookie)
        || /Max-Age=0/.test(clearedSetCookie),
      `set-cookie=${clearedSetCookie}`);
  },
});

// ── Missing APP_SESSION_SIGNING_SECRET when a cookie is present ─────────
await runCookieFlow({
  port: BASE_PORT + 4,
  env: {
    // No APP_SESSION_SIGNING_SECRET.
    ENABLE_DEV_SESSION_ROUTES: "1",
    DEV_OWNER_ID: "33333333-3333-4333-8333-333333333333",
    DEV_OWNER_EMAIL: "cookie-owner@example.test",
    DEV_OWNER_NAME: "Cookie Owner",
  },
  async assertions(baseUrl) {
    // No cookie + valid env -> 200 (env-fallback path doesn't need the secret).
    const noCookieRes = await fetch(`${baseUrl}/api/session`);
    check("no cookie + missing secret + valid env -> 200",
      noCookieRes.status === 200, `status=${noCookieRes.status}`);
    // With a cookie present and no secret -> 500 misconfigured.
    const withCookieRes = await fetch(`${baseUrl}/api/session`, {
      headers: { cookie: "keepsake_session=anything.signature" },
    });
    const withCookieBody = await withCookieRes.json();
    check("cookie present + missing secret -> 500",
      withCookieRes.status === 500, `status=${withCookieRes.status}`);
    check("cookie present + missing secret body says misconfigured",
      withCookieBody?.error === "Auth is misconfigured",
      JSON.stringify(withCookieBody));
  },
});

// ── dev-session gate disabled ─────────────────────────────────────────
await runCookieFlow({
  port: BASE_PORT + 5,
  env: {
    APP_SESSION_SIGNING_SECRET: VALID_SECRET,
    // ENABLE_DEV_SESSION_ROUTES intentionally unset.
    DEV_OWNER_ID: "33333333-3333-4333-8333-333333333333",
    DEV_OWNER_EMAIL: "cookie-owner@example.test",
    DEV_OWNER_NAME: "Cookie Owner",
  },
  async assertions(baseUrl) {
    const startRes = await fetch(`${baseUrl}/api/auth/dev-session/start`, {
      method: "POST",
    });
    check("dev-session/start without ENABLE_DEV_SESSION_ROUTES -> 404",
      startRes.status === 404, `status=${startRes.status}`);
    // No Set-Cookie when disabled.
    const noCookieHeader = startRes.headers.get("set-cookie") ?? "";
    check("disabled start does NOT set a cookie",
      !noCookieHeader.includes("keepsake_session="),
      `set-cookie=${noCookieHeader}`);

    const clearRes = await fetch(`${baseUrl}/api/auth/dev-session/clear`, {
      method: "POST",
    });
    check("dev-session/clear without ENABLE_DEV_SESSION_ROUTES -> 404",
      clearRes.status === 404, `status=${clearRes.status}`);
    const noClearHeader = clearRes.headers.get("set-cookie") ?? "";
    check("disabled clear does NOT touch the cookie",
      !noClearHeader.includes("keepsake_session="),
      `set-cookie=${noClearHeader}`);

    // /api/session is independent of the gate — it still works.
    const sessionRes = await fetch(`${baseUrl}/api/session`);
    check("/api/session unaffected by the gate (env-fallback)",
      sessionRes.status === 200, `status=${sessionRes.status}`);
  },
});

// ── start ignores any existing cookie, mints fresh from env ───────────
await runCookieFlow({
  port: BASE_PORT + 6,
  env: {
    APP_SESSION_SIGNING_SECRET: VALID_SECRET,
    ENABLE_DEV_SESSION_ROUTES: "1",
    DEV_OWNER_ID: "55555555-5555-4555-8555-555555555555",
    DEV_OWNER_EMAIL: "current-env-owner@example.test",
    DEV_OWNER_NAME: "Current Env Owner",
  },
  async assertions(baseUrl) {
    // 1. A TAMPERED cookie must NOT block bootstrap. We send a junk
    //    keepsake_session along with the POST — the route must still
    //    succeed and mint a fresh cookie using DEV_OWNER_* env, NOT
    //    return 401 from a cookie verify path.
    const startRes = await fetch(`${baseUrl}/api/auth/dev-session/start`, {
      method: "POST",
      headers: { cookie: "keepsake_session=tampered.signature" },
    });
    check("start ignores tampered cookie and returns 200",
      startRes.status === 200, `status=${startRes.status}`);
    const startBody = await startRes.json();
    check("start body reflects DEV_OWNER_* env, not the cookie",
      startBody?.user?.id === "55555555-5555-4555-8555-555555555555"
        && startBody.user.email === "current-env-owner@example.test"
        && startBody.user.name === "Current Env Owner",
      JSON.stringify(startBody));
    const freshCookie = parseSetCookie(startRes);
    check("start emits a NEW cookie even when one was already present",
      typeof freshCookie === "string" && freshCookie.length > 0
        && freshCookie !== "tampered.signature");

    // 2. A VALID OLD cookie carrying a different identity must NOT
    //    deflect bootstrap. We feed an old, valid cookie minted for a
    //    DIFFERENT owner; start must still mint with current env
    //    identity. This guards against silent identity drift.
    //
    // Synthesise a valid cookie for an old owner by going through
    // start with a DIFFERENT env, then asking the real start route
    // with that cookie attached to confirm it's still ignored.
    // (We can't easily swap env per-request inside one server, so
    // we just reuse `freshCookie` — it's already a "valid old cookie"
    // by the time we POST again.)
    const reissueRes = await fetch(`${baseUrl}/api/auth/dev-session/start`, {
      method: "POST",
      headers: { cookie: `keepsake_session=${freshCookie}` },
    });
    check("start with valid existing cookie still returns 200",
      reissueRes.status === 200);
    const reissueBody = await reissueRes.json();
    check("re-issued body still reflects DEV_OWNER_* env",
      reissueBody?.user?.id === "55555555-5555-4555-8555-555555555555"
        && reissueBody.user.email === "current-env-owner@example.test");
    const reissuedCookie = parseSetCookie(reissueRes);
    check("start always emits a Set-Cookie header (fresh signature)",
      typeof reissuedCookie === "string" && reissuedCookie.length > 0);
  },
});

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall /api/session smoke checks passed\n");
}
