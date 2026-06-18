// Smoke for the P6-D sign-out route + Profile sign-out wiring.
// No Docker. The /api/auth/signout route must:
//
//   * accept POST and respond 303 to /signin (default)
//   * clear the keepsake_session cookie (Max-Age=0)
//   * honour a safe relative ?returnTo=, fall back to /signin on
//     anything else
//   * work without DB / Google / Gmail wiring — sign-out must never
//     depend on any of them
//
// And the Profile page must:
//
//   * render the real form (action=/api/auth/signout, method=post)
//     when a session cookie is present
//   * stop rendering and redirect to /signin?returnTo=/profile once
//     the cookie is cleared

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const BASE_PORT = Number(process.env.TEST_SIGNOUT_PORT ?? 3197);
const nextBin = resolve(projectRoot, "node_modules/.bin/next");
const VALID_SECRET = "test-signout-app-session-secret-min-32-chars-ok";

const TEST_USER = {
  id: "99999999-9999-4999-9999-999999999999",
  email: "signout-owner@example.test",
  name: "Signout Owner",
};

const ENV_KEYS = [
  "DEV_OWNER_ID",
  "DEV_OWNER_EMAIL",
  "DEV_OWNER_NAME",
  "DATABASE_URL",
  "DEV_ENCRYPTION_KEY_BASE64",
  "KEEPSAKE_DATA_SOURCE",
  "APP_SESSION_SIGNING_SECRET",
  "ENABLE_DEV_SESSION_ROUTES",
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
  const env = { ...process.env, BROWSER: "none", NEXT_TELEMETRY_DISABLED: "1" };
  for (const k of ENV_KEYS) delete env[k];
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

async function mintCookie(baseUrl) {
  const res = await fetch(`${baseUrl}/api/auth/dev-session/start`, {
    method: "POST",
  });
  if (res.status !== 200) {
    throw new Error(`dev-session/start failed: status=${res.status}`);
  }
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.match(/keepsake_session=([^;]+)/)?.[1] ?? "";
}

// Set-Cookie "clears" the session if either the value is empty or
// Max-Age=0 / a past Expires is set. We check both signals so the
// test is robust to library framing.
function setCookieClearsSession(setCookie) {
  if (!setCookie) return false;
  if (!/keepsake_session=/.test(setCookie)) return false;
  const emptyValue = /keepsake_session=(;|$)/.test(setCookie);
  const maxAgeZero = /Max-Age=0/i.test(setCookie);
  const expiredEpoch = /Expires=Thu, 01 Jan 1970/i.test(setCookie);
  return emptyValue || maxAgeZero || expiredEpoch;
}

// ── Phase 1: POST /api/auth/signout → 303 /signin + cleared cookie ────
await runPhase({
  name: "signout: POST -> 303 /signin and clears cookie",
  port: BASE_PORT,
  env: {
    APP_SESSION_SIGNING_SECRET: VALID_SECRET,
    ENABLE_DEV_SESSION_ROUTES: "1",
    DEV_OWNER_ID: TEST_USER.id,
    DEV_OWNER_EMAIL: TEST_USER.email,
    DEV_OWNER_NAME: TEST_USER.name,
  },
  async run(baseUrl) {
    // 1a. No prior cookie — signout still works.
    {
      const res = await fetch(`${baseUrl}/api/auth/signout`, {
        method: "POST",
        redirect: "manual",
      });
      check("POST /api/auth/signout (no cookie) -> 303",
        res.status === 303, `status=${res.status}`);
      const loc = res.headers.get("location") ?? "";
      check("signout default redirect targets /signin",
        loc === "/signin" || loc === `${baseUrl}/signin`,
        `location=${loc}`);
      const setCookie = res.headers.get("set-cookie") ?? "";
      check("signout response clears keepsake_session",
        setCookieClearsSession(setCookie), `set-cookie=${setCookie}`);
    }

    // 1b. With a valid prior cookie — same response shape, cookie cleared.
    const cookie = await mintCookie(baseUrl);
    {
      const res = await fetch(`${baseUrl}/api/auth/signout`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie: `keepsake_session=${cookie}` },
      });
      check("POST /api/auth/signout (with cookie) -> 303",
        res.status === 303, `status=${res.status}`);
      const setCookie = res.headers.get("set-cookie") ?? "";
      check("signout still clears keepsake_session when one was sent",
        setCookieClearsSession(setCookie), `set-cookie=${setCookie}`);
    }

    // 1c. Safe relative returnTo is honoured.
    {
      const res = await fetch(
        `${baseUrl}/api/auth/signout?returnTo=${encodeURIComponent("/signin?from=profile")}`,
        { method: "POST", redirect: "manual" },
      );
      const loc = res.headers.get("location") ?? "";
      check("signout honours safe returnTo",
        res.status === 303 && loc.endsWith("/signin?from=profile"),
        `location=${loc}`);
    }

    // 1d. Unsafe returnTo falls back to /signin (NOT to "/").
    {
      const res = await fetch(
        `${baseUrl}/api/auth/signout?returnTo=${encodeURIComponent("//evil.example/x")}`,
        { method: "POST", redirect: "manual" },
      );
      const loc = res.headers.get("location") ?? "";
      check("signout rejects protocol-relative returnTo and falls back to /signin",
        res.status === 303 && (loc === "/signin" || loc === `${baseUrl}/signin`),
        `location=${loc}`);
    }
    {
      const res = await fetch(
        `${baseUrl}/api/auth/signout?returnTo=${encodeURIComponent("https://evil.example/x")}`,
        { method: "POST", redirect: "manual" },
      );
      const loc = res.headers.get("location") ?? "";
      check("signout rejects absolute returnTo and falls back to /signin",
        res.status === 303 && (loc === "/signin" || loc === `${baseUrl}/signin`),
        `location=${loc}`);
    }
  },
});

// ── Phase 2: /profile renders signout form when authed, redirects after ─
await runPhase({
  name: "profile: signout form present, then cleared cookie -> /signin",
  port: BASE_PORT + 1,
  env: {
    APP_SESSION_SIGNING_SECRET: VALID_SECRET,
    ENABLE_DEV_SESSION_ROUTES: "1",
    DEV_OWNER_ID: TEST_USER.id,
    DEV_OWNER_EMAIL: TEST_USER.email,
    DEV_OWNER_NAME: TEST_USER.name,
  },
  async run(baseUrl) {
    const cookie = await mintCookie(baseUrl);

    // Authed → 200 + real form action in HTML.
    {
      const res = await fetch(`${baseUrl}/profile`, {
        redirect: "manual",
        headers: { cookie: `keepsake_session=${cookie}` },
      });
      check("/profile authed -> 200", res.status === 200,
        `status=${res.status}`);
      const body = await res.text();
      check("/profile HTML contains signout form",
        body.includes('data-testid="profile-signout-form"'),
        "missing data-testid=profile-signout-form");
      check("signout form posts to /api/auth/signout",
        body.includes('action="/api/auth/signout"')
          && body.includes('method="post"'),
        "missing action=/api/auth/signout or method=post");
      check("signout form has a real submit button (not just a static row)",
        body.includes('data-testid="profile-signout-button"')
          && body.includes('type="submit"'),
        "missing submit button");
    }

    // POST signout → 303, capture the cleared cookie value.
    let clearedCookieAttr = "";
    {
      const res = await fetch(`${baseUrl}/api/auth/signout`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie: `keepsake_session=${cookie}` },
      });
      check("signout POST after profile view -> 303",
        res.status === 303, `status=${res.status}`);
      const setCookie = res.headers.get("set-cookie") ?? "";
      check("signout response clears the same cookie",
        setCookieClearsSession(setCookie), `set-cookie=${setCookie}`);
      // Extract just the name=value pair so we can replay it.
      clearedCookieAttr =
        setCookie.match(/keepsake_session=[^;]*/)?.[0] ?? "keepsake_session=";
    }

    // Hitting /profile again with the cleared cookie should redirect
    // unauthenticated visitors back to /signin?returnTo=/profile.
    {
      const res = await fetch(`${baseUrl}/profile`, {
        redirect: "manual",
        headers: { cookie: clearedCookieAttr },
      });
      check("/profile after signout -> 307",
        res.status === 307 || res.status === 308,
        `status=${res.status}`);
      const loc = res.headers.get("location") ?? "";
      check("/profile after signout redirects to /signin?returnTo=/profile",
        loc.endsWith(`/signin?returnTo=${encodeURIComponent("/profile")}`),
        `location=${loc}`);
    }
  },
});

// ── Phase 3: signout works with NO DB / Google / Gmail env wiring ─────
await runPhase({
  name: "signout: works without DB / Google / Gmail env",
  port: BASE_PORT + 2,
  env: {
    APP_SESSION_SIGNING_SECRET: VALID_SECRET,
    // Deliberately omit DEV_OWNER_*, DATABASE_URL, OAuth client envs,
    // KEEPSAKE_DATA_SOURCE. The route must not touch any of them.
  },
  async run(baseUrl) {
    const res = await fetch(`${baseUrl}/api/auth/signout`, {
      method: "POST",
      redirect: "manual",
    });
    check("signout still 303s with no auxiliary env",
      res.status === 303, `status=${res.status}`);
    const loc = res.headers.get("location") ?? "";
    check("signout still redirects to /signin with no auxiliary env",
      loc === "/signin" || loc === `${baseUrl}/signin`,
      `location=${loc}`);
    const setCookie = res.headers.get("set-cookie") ?? "";
    check("signout still clears cookie with no auxiliary env",
      setCookieClearsSession(setCookie), `set-cookie=${setCookie}`);
  },
});

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall /api/auth/signout smoke checks passed\n");
}
