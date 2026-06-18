// Default smoke for POST /api/webhooks/deliveries.
//
// No Docker. Covers the provider-agnostic webhook contract in mock mode:
//
//   * missing DELIVERY_WEBHOOK_SECRET -> 501 not_configured
//   * bad secret header               -> 401 unauthorized
//   * malformed JSON                  -> 400 invalid_json
//   * invalid event payload           -> 400 invalid_event (+ detail)
//   * valid event in mock mode        -> 404 delivery_not_found
//   * webhook never reads current user / DB / Gmail

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const BASE_PORT = Number(process.env.TEST_WEBHOOK_DELIVERIES_PORT ?? 3210);
const nextBin = resolve(projectRoot, "node_modules/.bin/next");
const VALID_SECRET = "test-delivery-webhook-secret-min-len-ok";

const ENV_KEYS = [
  "DEV_OWNER_ID",
  "DEV_OWNER_EMAIL",
  "DEV_OWNER_NAME",
  "DATABASE_URL",
  "DEV_ENCRYPTION_KEY_BASE64",
  "KEEPSAKE_DATA_SOURCE",
  "DELIVERY_WEBHOOK_SECRET",
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

const validBody = {
  provider: "mock",
  providerMessageId: "msg-does-not-exist",
  event: "delivered",
};

function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// ── Phase 1: gate — missing secret env returns 501 ─────────────────────
await runPhase({
  name: "webhook: missing DELIVERY_WEBHOOK_SECRET -> 501",
  port: BASE_PORT,
  env: {
    // DELIVERY_WEBHOOK_SECRET intentionally unset.
  },
  async run(baseUrl) {
    const res = await postJson(
      `${baseUrl}/api/webhooks/deliveries`,
      validBody,
      { [`x-keepsake-webhook-secret`]: "anything" },
    );
    check("missing secret -> 501", res.status === 501,
      `status=${res.status}`);
    const json = await res.json().catch(() => ({}));
    check("missing secret code = not_configured",
      json.code === "not_configured", `code=${json.code}`);
  },
});

// ── Phase 2: gate — wrong secret -> 401 ────────────────────────────────
await runPhase({
  name: "webhook: wrong secret -> 401",
  port: BASE_PORT + 1,
  env: { DELIVERY_WEBHOOK_SECRET: VALID_SECRET },
  async run(baseUrl) {
    // No header at all.
    {
      const res = await postJson(`${baseUrl}/api/webhooks/deliveries`, validBody);
      check("no secret header -> 401", res.status === 401,
        `status=${res.status}`);
    }
    // Wrong value.
    {
      const res = await postJson(
        `${baseUrl}/api/webhooks/deliveries`,
        validBody,
        { "x-keepsake-webhook-secret": "wrong" },
      );
      check("wrong secret header -> 401", res.status === 401,
        `status=${res.status}`);
      const json = await res.json().catch(() => ({}));
      check("wrong secret code = unauthorized",
        json.code === "unauthorized", `code=${json.code}`);
    }
  },
});

// ── Phase 3: body validation ──────────────────────────────────────────
await runPhase({
  name: "webhook: body shape validation",
  port: BASE_PORT + 2,
  env: { DELIVERY_WEBHOOK_SECRET: VALID_SECRET },
  async run(baseUrl) {
    const headers = { "x-keepsake-webhook-secret": VALID_SECRET };

    // Malformed JSON -> 400 invalid_json
    {
      const res = await postJson(
        `${baseUrl}/api/webhooks/deliveries`,
        "{not json",
        headers,
      );
      check("malformed JSON -> 400", res.status === 400);
      const json = await res.json().catch(() => ({}));
      check("malformed JSON code = invalid_json",
        json.code === "invalid_json", `code=${json.code}`);
    }

    // Bad provider -> 400 invalid_event/provider
    {
      const res = await postJson(
        `${baseUrl}/api/webhooks/deliveries`,
        { provider: "smoke-signals", providerMessageId: "x", event: "delivered" },
        headers,
      );
      const json = await res.json().catch(() => ({}));
      check("bad provider -> 400 invalid_event",
        res.status === 400 && json.code === "invalid_event",
        `status=${res.status} code=${json.code}`);
      check("bad provider detail = provider",
        json.detail === "provider", `detail=${json.detail}`);
    }

    // Bad event -> 400 invalid_event/event
    {
      const res = await postJson(
        `${baseUrl}/api/webhooks/deliveries`,
        { provider: "mock", providerMessageId: "x", event: "exploded" },
        headers,
      );
      const json = await res.json().catch(() => ({}));
      check("bad event -> 400 invalid_event/event",
        res.status === 400 && json.code === "invalid_event"
          && json.detail === "event",
        `status=${res.status} code=${json.code} detail=${json.detail}`);
    }

    // Missing providerMessageId -> 400 invalid_event/providerMessageId
    {
      const res = await postJson(
        `${baseUrl}/api/webhooks/deliveries`,
        { provider: "mock", event: "delivered" },
        headers,
      );
      const json = await res.json().catch(() => ({}));
      check("missing providerMessageId -> 400 invalid_event",
        res.status === 400 && json.code === "invalid_event"
          && json.detail === "providerMessageId",
        `status=${res.status} code=${json.code} detail=${json.detail}`);
    }

    // Bad occurredAtISO -> 400 invalid_event/occurredAtISO
    {
      const res = await postJson(
        `${baseUrl}/api/webhooks/deliveries`,
        {
          provider: "mock",
          providerMessageId: "x",
          event: "delivered",
          occurredAtISO: "not-a-date",
        },
        headers,
      );
      const json = await res.json().catch(() => ({}));
      check("bad occurredAtISO -> 400 invalid_event/occurredAtISO",
        res.status === 400 && json.code === "invalid_event"
          && json.detail === "occurredAtISO",
        `status=${res.status} code=${json.code} detail=${json.detail}`);
    }
  },
});

// ── Phase 4: mock mode resolves to delivery_not_found ──────────────────
await runPhase({
  name: "webhook: valid event in mock mode -> 404 delivery_not_found",
  port: BASE_PORT + 3,
  env: { DELIVERY_WEBHOOK_SECRET: VALID_SECRET },
  async run(baseUrl) {
    const headers = { "x-keepsake-webhook-secret": VALID_SECRET };
    const res = await postJson(
      `${baseUrl}/api/webhooks/deliveries`,
      validBody,
      headers,
    );
    check("valid event in mock mode -> 404",
      res.status === 404, `status=${res.status}`);
    const json = await res.json().catch(() => ({}));
    check("delivery_not_found code",
      json.code === "delivery_not_found", `code=${json.code}`);
  },
});

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall /api/webhooks/deliveries smoke checks passed\n");
}
