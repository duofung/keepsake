// Smoke for the P6-C sign-in page + unauthenticated-page redirects.
// No Docker. The page-level guard is the
// `requireSessionUserOrRedirect()` helper, which only accepts a real
// `keepsake_session` cookie (no env fallback). This test covers:
//
//   * /signin renders for unauthenticated visitors
//   * /signin redirects to returnTo when a valid cookie is present
//   * /signin shows the dev CTA only when ENABLE_DEV_SESSION_ROUTES=1
//   * /profile, /workspace, /history, /people, / redirect to
//     /signin?returnTo=<page> when unauthenticated
//   * those pages 200 when a valid session cookie is present
//   * /signin's returnTo accepts only relative paths
//   * misconfigured auth surfaces as a server error (5xx), NOT a
//     silent /signin redirect

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const BASE_PORT = Number(process.env.TEST_SIGNIN_PORT ?? 3190);
const nextBin = resolve(projectRoot, "node_modules/.bin/next");
const VALID_SECRET = "test-signin-app-session-secret-min-32-chars-ok";

const TEST_USER = {
  id: "88888888-8888-4888-8888-888888888888",
  email: "signin-owner@example.test",
  name: "Signin Owner",
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

// ── Phase 1: /signin renders for unauth + Google CTA wires through ────
await runPhase({
  name: "signin: unauth render + Google CTA",
  port: BASE_PORT,
  env: {
    APP_SESSION_SIGNING_SECRET: VALID_SECRET,
    ENABLE_DEV_SESSION_ROUTES: "1",
    DEV_OWNER_ID: TEST_USER.id,
    DEV_OWNER_EMAIL: TEST_USER.email,
    DEV_OWNER_NAME: TEST_USER.name,
  },
  async run(baseUrl) {
    const res = await fetch(`${baseUrl}/signin`, { redirect: "manual" });
    check("/signin -> 200", res.status === 200, `status=${res.status}`);
    const body = await res.text();
    check("signin page rendered", body.includes('data-testid="signin-page"'));
    check("signin frames ReMaster as an account/contact workspace",
      body.includes("account/contact workspace")
        && body.includes("connect Gmail later from Profile"));
    check("Google CTA targets /api/auth/google/start",
      body.includes('data-testid="signin-google-cta"')
        && body.includes('href="/api/auth/google/start?returnTo='));
    check("dev CTA is visible when ENABLE_DEV_SESSION_ROUTES=1",
      body.includes('data-testid="signin-dev-cta"'));
    check("dev form posts to dev-session/start with returnTo",
      body.includes('action="/api/auth/dev-session/start?returnTo='));
  },
});

// ── Phase 2: /signin with valid session redirects to returnTo ─────────
await runPhase({
  name: "signin: authed -> returnTo",
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
    // Default returnTo → "/"
    {
      const res = await fetch(`${baseUrl}/signin`, {
        redirect: "manual",
        headers: { cookie: `keepsake_session=${cookie}` },
      });
      check("/signin with cookie -> 307", res.status === 307,
        `status=${res.status}`);
      const location = res.headers.get("location") ?? "";
      check("/signin authed redirects to /",
        location === "/" || location === `${baseUrl}/`,
        `location=${location}`);
    }
    // Custom returnTo
    {
      const res = await fetch(
        `${baseUrl}/signin?returnTo=${encodeURIComponent("/profile")}`,
        { redirect: "manual", headers: { cookie: `keepsake_session=${cookie}` } },
      );
      check("/signin authed honours custom returnTo (/profile)",
        res.status === 307
          && (res.headers.get("location") ?? "").endsWith("/profile"));
    }
    // returnTo must be a relative path — protocol-relative or absolute
    // URLs are rejected and we fall back to "/".
    {
      const res = await fetch(
        `${baseUrl}/signin?returnTo=${encodeURIComponent("//evil.example/x")}`,
        { redirect: "manual", headers: { cookie: `keepsake_session=${cookie}` } },
      );
      const location = res.headers.get("location") ?? "";
      check("/signin rejects protocol-relative returnTo",
        res.status === 307 && (location === "/" || location === `${baseUrl}/`),
        `location=${location}`);
    }
    {
      const res = await fetch(
        `${baseUrl}/signin?returnTo=${encodeURIComponent("https://evil.example/x")}`,
        { redirect: "manual", headers: { cookie: `keepsake_session=${cookie}` } },
      );
      const location = res.headers.get("location") ?? "";
      check("/signin rejects absolute returnTo",
        res.status === 307 && (location === "/" || location === `${baseUrl}/`));
    }
  },
});

// ── Phase 3: dev CTA hidden when ENABLE_DEV_SESSION_ROUTES is unset ───
await runPhase({
  name: "signin: dev CTA hidden when disabled",
  port: BASE_PORT + 2,
  env: {
    APP_SESSION_SIGNING_SECRET: VALID_SECRET,
    // ENABLE_DEV_SESSION_ROUTES intentionally unset.
    DEV_OWNER_ID: TEST_USER.id,
    DEV_OWNER_EMAIL: TEST_USER.email,
    DEV_OWNER_NAME: TEST_USER.name,
  },
  async run(baseUrl) {
    const res = await fetch(`${baseUrl}/signin`);
    const body = await res.text();
    check("signin still renders", res.status === 200);
    check("Google CTA still visible",
      body.includes('data-testid="signin-google-cta"'));
    check("dev CTA NOT rendered when gate is off",
      !body.includes('data-testid="signin-dev-cta"'));
    check("dev form NOT rendered when gate is off",
      !body.includes('data-testid="signin-dev-form"'));
  },
});

// ── Phase 4: unauthenticated pages redirect to /signin with returnTo ──
await runPhase({
  name: "pages: unauthenticated -> /signin",
  port: BASE_PORT + 3,
  env: {
    APP_SESSION_SIGNING_SECRET: VALID_SECRET,
    // DEV_OWNER_* deliberately UNSET so the env fallback fails and the
    // pages MUST go through the unauthenticated branch. The page guard
    // doesn't consult env at all, but this keeps the test honest.
    KEEPSAKE_DATA_SOURCE: "mock",
  },
  async run(baseUrl) {
    const cases = [
      { path: "/", expected: "/" },
      { path: "/profile", expected: "/profile" },
      { path: "/people", expected: "/people" },
      { path: "/history", expected: "/history" },
      { path: "/workspace?person=p-lin", expected: "/workspace?person=p-lin" },
    ];
    for (const { path, expected } of cases) {
      const res = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
      check(`${path} unauth -> redirect`,
        res.status === 307 || res.status === 308,
        `status=${res.status}`);
      const location = res.headers.get("location") ?? "";
      const expectedSignin = expected === "/"
        ? "/signin"
        : `/signin?returnTo=${encodeURIComponent(expected)}`;
      check(`${path} redirects to ${expectedSignin}`,
        location.endsWith(expectedSignin),
        `location=${location}`);
    }
  },
});

// ── Phase 5: authenticated pages render with cookie ───────────────────
await runPhase({
  name: "pages: authenticated -> 200",
  port: BASE_PORT + 4,
  env: {
    APP_SESSION_SIGNING_SECRET: VALID_SECRET,
    ENABLE_DEV_SESSION_ROUTES: "1",
    DEV_OWNER_ID: TEST_USER.id,
    DEV_OWNER_EMAIL: TEST_USER.email,
    DEV_OWNER_NAME: TEST_USER.name,
    KEEPSAKE_DATA_SOURCE: "mock",
  },
  async run(baseUrl) {
    const cookie = await mintCookie(baseUrl);
    const cookieHeader = `keepsake_session=${cookie}`;
    for (const path of ["/", "/profile", "/people", "/history", "/workspace?person=p-lin"]) {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: { cookie: cookieHeader },
        redirect: "manual",
      });
      check(`${path} with cookie -> 200`,
        res.status === 200, `path=${path} status=${res.status}`);
    }
  },
});

// ── Phase 6: misconfigured auth surfaces as 5xx, NOT a /signin redirect
// We send a tampered cookie + don't set APP_SESSION_SIGNING_SECRET. The
// auth seam should classify this as `misconfigured` (the verify helper
// can't even check the signature) and propagate as 500, not redirect.
await runPhase({
  name: "pages: misconfigured -> 500 (not redirect)",
  port: BASE_PORT + 5,
  env: {
    // APP_SESSION_SIGNING_SECRET intentionally UNSET.
    DEV_OWNER_ID: TEST_USER.id,
    DEV_OWNER_EMAIL: TEST_USER.email,
    DEV_OWNER_NAME: TEST_USER.name,
    KEEPSAKE_DATA_SOURCE: "mock",
  },
  async run(baseUrl) {
    const res = await fetch(`${baseUrl}/profile`, {
      headers: { cookie: "keepsake_session=anything.signature" },
      redirect: "manual",
    });
    check("/profile misconfigured -> 500", res.status === 500,
      `status=${res.status}`);
    check("/profile misconfigured does NOT redirect to /signin",
      res.status !== 307 && res.status !== 308);
  },
});

// ── Phase 7: DB mode + unauthenticated MUST still redirect to /signin ──
// Regression guard: `/` and `/workspace` previously ran the auth guard
// and the people payload in Promise.all, which in KEEPSAKE_DATA_SOURCE=db
// raced a `redirect()` against `getPeoplePayload()` → `currentUserIdOrThrow()`
// → unauthenticated AuthError, sometimes winning the throw and leaking
// a 500. The fix is sequential await. We don't even need a reachable
// DB to prove the redirect happens first — set a bogus DATABASE_URL
// and watch the page never reach the DB code path.
await runPhase({
  name: "pages: DB-mode unauth -> /signin (no 500 race)",
  port: BASE_PORT + 6,
  env: {
    APP_SESSION_SIGNING_SECRET: VALID_SECRET,
    // DEV_OWNER_* deliberately unset so env fallback can't bail us out.
    KEEPSAKE_DATA_SOURCE: "db",
    // Deliberately bogus: the page must never reach the DB layer when
    // the visitor is unauthenticated. If it does, this URL would 5xx.
    DATABASE_URL: "postgres://nobody:nope@127.0.0.1:1/keepsake",
    KEEPSAKE_WORKER_DATABASE_URL: "postgres://nobody:nope@127.0.0.1:1/keepsake",
    DEV_ENCRYPTION_KEY_BASE64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  },
  async run(baseUrl) {
    // /  -> /signin
    {
      const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
      check("/ DB-mode unauth -> 307",
        res.status === 307 || res.status === 308,
        `status=${res.status}`);
      check("/ DB-mode unauth is NOT 500",
        res.status !== 500, `status=${res.status}`);
      const loc = res.headers.get("location") ?? "";
      check("/ DB-mode unauth lands on /signin",
        loc.endsWith("/signin"), `location=${loc}`);
    }
    // /workspace?person=p-lin -> /signin?returnTo=/workspace?person=p-lin
    {
      const res = await fetch(
        `${baseUrl}/workspace?person=p-lin`,
        { redirect: "manual" },
      );
      check("/workspace?person=p-lin DB-mode unauth -> 307",
        res.status === 307 || res.status === 308,
        `status=${res.status}`);
      check("/workspace DB-mode unauth is NOT 500",
        res.status !== 500, `status=${res.status}`);
      const loc = res.headers.get("location") ?? "";
      check("/workspace DB-mode unauth preserves ?person= in returnTo",
        loc.endsWith(`/signin?returnTo=${encodeURIComponent("/workspace?person=p-lin")}`),
        `location=${loc}`);
    }
  },
});

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall /signin smoke checks passed\n");
}
