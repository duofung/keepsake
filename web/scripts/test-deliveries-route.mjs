// Default smoke for POST /api/deliveries. No Docker.
//
// Covers validation paths and the mock-dispatcher happy path:
//   * malformed JSON / missing fields / bad UUIDs / bad channel → 400
//   * missing dev auth → 401
//   * mock mode happy path → 202 with a QueuedDelivery-shaped body
//
// The DB happy path (sender precondition, real draft lookup, encrypted row
// insert) is covered by `pnpm test:db:deliveries-route`.
//
// Run via: pnpm test:deliveries

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const BASE_PORT = Number(process.env.TEST_DELIVERIES_PORT ?? 3155);
const nextBin = resolve(projectRoot, "node_modules/.bin/next");

const AUTH_ENV_KEYS = [
  "DEV_OWNER_ID",
  "DEV_OWNER_EMAIL",
  "DEV_OWNER_NAME",
  "KEEPSAKE_DATA_SOURCE",
];

const validAuth = {
  DEV_OWNER_ID: "55555555-5555-4555-8555-555555555555",
  DEV_OWNER_EMAIL: "deliveries-owner@example.test",
  DEV_OWNER_NAME: "Deliveries Owner",
};

const personId = "11111111-1111-4111-8111-111111111111";
const occasionId = "22222222-2222-4222-8222-222222222222";

const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
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

async function postDeliveries(baseUrl, body, init = {}) {
  const res = await fetch(`${baseUrl}/api/deliveries`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
  const responseBody = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body: responseBody };
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

process.stdout.write("running /api/deliveries route checks:\n");

await runServer({
  name: "mock mode validation + happy path",
  port: BASE_PORT,
  env: { ...validAuth, KEEPSAKE_DATA_SOURCE: "mock" },
  async assertions(baseUrl) {
    // ── malformed JSON ───────────────────────────────────────────────
    const malformed = await postDeliveries(baseUrl, "{not json", {});
    check("malformed JSON -> 400", malformed.status === 400, `status=${malformed.status}`);
    check("malformed code = invalid_request", malformed.body?.code === "invalid_request");

    // ── missing personId ─────────────────────────────────────────────
    const missingPerson = await postDeliveries(baseUrl, { channel: "email", occasionId: null });
    check("missing personId -> 400", missingPerson.status === 400);
    check("missing personId code = invalid_request", missingPerson.body?.code === "invalid_request");

    // ── missing channel ──────────────────────────────────────────────
    const missingChannel = await postDeliveries(baseUrl, { personId, occasionId: null });
    check("missing channel -> 400", missingChannel.status === 400);
    check("missing channel code = invalid_request", missingChannel.body?.code === "invalid_request");

    // ── bad personId UUID ────────────────────────────────────────────
    const badPerson = await postDeliveries(baseUrl, { personId: "not-a-uuid", occasionId: null, channel: "email" });
    check("non-uuid personId -> 400", badPerson.status === 400);
    check("non-uuid personId code = invalid_request", badPerson.body?.code === "invalid_request");

    // ── bad occasionId UUID ──────────────────────────────────────────
    const badOccasion = await postDeliveries(baseUrl, { personId, occasionId: "nope", channel: "email" });
    check("non-uuid occasionId -> 400", badOccasion.status === 400);

    // ── bad channel ──────────────────────────────────────────────────
    const badChannel = await postDeliveries(baseUrl, { personId, occasionId: null, channel: "telex" });
    check("bad channel -> 400", badChannel.status === 400);

    // ── mock happy path: email ───────────────────────────────────────
    const emailQueue = await postDeliveries(baseUrl, { personId, occasionId, channel: "email" });
    check("mock email -> 202", emailQueue.status === 202, `status=${emailQueue.status}`);
    check("mock email queued shape: status=queued", emailQueue.body?.status === "queued");
    check("mock email echoes personId", emailQueue.body?.personId === personId);
    check("mock email echoes occasionId", emailQueue.body?.occasionId === occasionId);
    check("mock email echoes channel", emailQueue.body?.channel === "email");
    check("mock email has uuid id", typeof emailQueue.body?.id === "string" && emailQueue.body.id.length === 36);
    check("mock email has draftId", typeof emailQueue.body?.draftId === "string");
    check("mock email scheduledForISO null", emailQueue.body?.scheduledForISO === null);
    check("mock email has createdAtISO", typeof emailQueue.body?.createdAtISO === "string");

    // ── mock happy path: post ────────────────────────────────────────
    const postQueue = await postDeliveries(baseUrl, { personId, occasionId: null, channel: "post" });
    check("mock post -> 202", postQueue.status === 202, `status=${postQueue.status}`);
    check("mock post echoes channel", postQueue.body?.channel === "post");
    check("mock post occasionId null", postQueue.body?.occasionId === null);
  },
});

await runServer({
  name: "missing auth",
  port: BASE_PORT + 1,
  env: {},
  async assertions(baseUrl) {
    const res = await postDeliveries(baseUrl, { personId, occasionId: null, channel: "email" });
    check("missing auth -> 401", res.status === 401, `status=${res.status}`);
    check("missing auth body", res.body?.error === "Unauthenticated");
  },
});

await runServer({
  name: "misconfigured data source",
  port: BASE_PORT + 2,
  env: { ...validAuth, KEEPSAKE_DATA_SOURCE: "banana" },
  async assertions(baseUrl) {
    // Validation runs against the request body BEFORE dispatcher, so a valid
    // body lets the dispatcher's strict dataSource throw. A 400 body would
    // short-circuit before the misconfigured branch.
    const res = await postDeliveries(baseUrl, { personId, occasionId: null, channel: "email" });
    check("misconfigured data source -> 500", res.status === 500, `status=${res.status}`);
    check(
      "misconfigured body shape matches /api/session",
      res.body?.error === "Auth is misconfigured",
      `body=${JSON.stringify(res.body)}`,
    );
  },
});

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall /api/deliveries route checks passed\n");
}
