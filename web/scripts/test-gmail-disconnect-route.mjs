// Smoke test for POST /api/gmail/disconnect. No Docker.
//
// Verifies the disconnect route adopts the same data-source contract as
// `/api/session` / `auth/current-user.server.ts`:
//   * KEEPSAKE_DATA_SOURCE=mock with valid dev auth → 303 to /profile
//   * KEEPSAKE_DATA_SOURCE=<typo> → 500 with the existing auth-misconfigured
//     error shape; no new error contract is invented
//
// The DB-backed flow (real disconnect of a connected account) is covered by
// `pnpm test:db:current-user`.
//
// Run via: pnpm test:gmail-disconnect

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const BASE_PORT = Number(process.env.TEST_GMAIL_DISCONNECT_PORT ?? 3152);
const nextBin = resolve(projectRoot, "node_modules/.bin/next");

const AUTH_ENV_KEYS = [
  "DEV_OWNER_ID",
  "DEV_OWNER_EMAIL",
  "DEV_OWNER_NAME",
  "KEEPSAKE_DATA_SOURCE",
];

const validAuth = {
  DEV_OWNER_ID: "88888888-8888-4888-8888-888888888888",
  DEV_OWNER_EMAIL: "disconnect-owner@example.test",
  DEV_OWNER_NAME: "Disconnect Owner",
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

function childEnv(extra) {
  const env = {
    ...process.env,
    BROWSER: "none",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  for (const key of AUTH_ENV_KEYS) {
    delete env[key];
  }
  return { ...env, ...extra };
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
    new Promise((resolveExited) => child.once("exit", () => resolveExited(true))),
    wait(3_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

async function postDisconnect(baseUrl) {
  const res = await fetch(`${baseUrl}/api/gmail/disconnect`, {
    method: "POST",
    redirect: "manual",
  });
  const body = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body, location: res.headers.get("location") };
}

async function runServer({ name, port, env, assertions }) {
  const baseUrl = `http://localhost:${port}`;
  const child = spawn(nextBin, ["dev", "--port", String(port)], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv(env),
  });

  let serverError = "";
  child.stderr.on("data", (chunk) => { serverError += chunk.toString(); });

  try {
    process.stdout.write(`booting next dev on :${port} for ${name}...\n`);
    await waitForReady(baseUrl);
    await assertions(baseUrl);
  } catch (error) {
    process.stdout.write(`harness error for ${name}: ${error?.message ?? error}\n`);
    if (serverError) process.stdout.write(serverError);
    failures.push(name);
  } finally {
    await stopServer(child);
  }
}

process.stdout.write("running gmail-disconnect data-source checks:\n");

await runServer({
  name: "mock data source",
  port: BASE_PORT,
  env: { ...validAuth, KEEPSAKE_DATA_SOURCE: "mock" },
  async assertions(baseUrl) {
    const res = await postDisconnect(baseUrl);
    check("mock POST -> 303", res.status === 303, `status=${res.status}`);
    check(
      "mock disconnect redirects to /profile",
      res.location === `${baseUrl}/profile`,
      res.location ?? "",
    );
  },
});

await runServer({
  name: "misconfigured data source",
  port: BASE_PORT + 1,
  env: { ...validAuth, KEEPSAKE_DATA_SOURCE: "banana" },
  async assertions(baseUrl) {
    const res = await postDisconnect(baseUrl);
    check("misconfigured POST -> 500", res.status === 500, `status=${res.status}`);
    check(
      "misconfigured body matches auth seam shape",
      res.body?.error === "Auth is misconfigured",
      JSON.stringify(res.body),
    );
  },
});

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall gmail-disconnect route checks passed\n");
}
