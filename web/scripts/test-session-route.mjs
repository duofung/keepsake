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
];
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

process.stdout.write("running /api/session smoke checks:\n");

for (const testCase of cases) {
  await runCase(testCase);
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall /api/session smoke checks passed\n");
}
