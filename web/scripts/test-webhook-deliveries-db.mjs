// DB-backed smoke for POST /api/webhooks/deliveries.
//
// Boots throwaway Postgres, seeds a handful of `deliveries` rows in
// known states with deterministic `provider_message_id`s, then drives
// the live route to exercise the full markStatus monotonic ladder:
//
//   * sent -> delivered           (status+delivered_at)
//   * delivered -> opened         (status+opened_at; delivered_at preserved)
//   * opened -> delivered         (no downgrade; idempotent ok)
//   * sent -> opened directly     (stamps delivered_at too)
//   * sent -> failed              (failure_reason persisted)
//   * delivered -> failed         (blocked; no downgrade)
//   * unknown providerMessageId   -> 404 delivery_not_found
//
// Run via: pnpm test:db:webhook-deliveries

import { spawn } from "node:child_process";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = normalize(join(__dirname, ".."));
const containerName = `keepsake-test-webhook-deliveries-${Date.now()}`;
const postgresImage = "postgres:17-alpine";
const port = Number(process.env.TEST_WEBHOOK_DELIVERIES_DB_PORT ?? 3215);
const base = `http://localhost:${port}`;
const WEBHOOK_SECRET = "test-delivery-webhook-secret-min-len-ok-db";

let containerStarted = false;
let nextChild = null;
let serverError = "";

function command(commandName, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(commandName, args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${commandName} ${args.join(" ")} failed: ${stderr || stdout}`));
    });
  });
}
async function docker(args) { return command("docker", args); }

async function withClient(databaseUrl, fn) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
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
  throw new Error(`Postgres did not become ready: ${lastError?.message ?? "unknown"}`);
}

async function runSqlFile(databaseUrl, path) {
  const sql = await readFile(join(projectRoot, path), "utf8");
  await withClient(databaseUrl, (client) => client.query(sql));
}

async function waitForNext() {
  const deadline = Date.now() + 60_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/session`);
      if (res.status < 500) return;
      lastError = new Error(`status ${res.status}`);
    } catch (error) { lastError = error; }
    await wait(500);
  }
  throw new Error(`Next dev did not become ready at ${base}: ${lastError?.message ?? "unknown"}`);
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

async function postWebhook(body, secretOverride = WEBHOOK_SECRET) {
  const res = await fetch(`${base}/api/webhooks/deliveries`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secretOverride !== null ? { "x-keepsake-webhook-secret": secretOverride } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body: json };
}

const failures = [];
function check(name, cond, detail = "") {
  if (cond) process.stdout.write(`  ✓ ${name}\n`);
  else {
    process.stdout.write(`  ✗ ${name}${detail ? `  (${detail})` : ""}\n`);
    failures.push(name);
  }
}

function encryptDeliveryColumn(encryptionKey, ownerId, column, plain) {
  const key = Buffer.from(encryptionKey, "base64");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${ownerId}|deliveries|${column}`, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plain, "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

async function seedSentDelivery(adminUrl, encryptionKey, ownerId, providerMessageId) {
  // Encrypt the placeholder recipient name + occasion label so the row
  // satisfies NOT NULL constraints. We don't decrypt anywhere in this
  // smoke; the webhook only touches status/timestamps/text fields.
  const enc = (column, plain) =>
    encryptDeliveryColumn(encryptionKey, ownerId, column, plain);
  const recipientName = enc("recipient_name_enc", "Recipient");
  const occasionLabel = enc("occasion_label_enc", "Test occasion");

  const id = randomUUID();
  await withClient(adminUrl, async (client) => {
    await client.query(
      `INSERT INTO deliveries (
        id, owner_id, recipient_name_enc, occasion_kind, occasion_label_enc,
        channel, sent_at, status, provider_message_id
      ) VALUES (
        $1::uuid, $2::uuid, $3, 'birthday'::occasion_kind, $4,
        'email'::channel, now() - interval '1 minute', 'sent'::delivery_status, $5
      )`,
      [id, ownerId, recipientName, occasionLabel, providerMessageId],
    );
  });
  return id;
}

async function fetchDeliveryRow(adminUrl, deliveryId) {
  return withClient(adminUrl, async (client) => {
    const res = await client.query(
      `SELECT status::text AS status,
              sent_at,
              delivered_at,
              opened_at,
              failure_reason,
              provider_status
       FROM deliveries WHERE id = $1::uuid`,
      [deliveryId],
    );
    return res.rows[0] ?? null;
  });
}

let harnessError = null;

try {
  process.stdout.write("checking Docker availability:\n");
  await docker(["--version"]);
  process.stdout.write("  ✓ docker CLI is available\n");

  process.stdout.write(`starting ${postgresImage}:\n`);
  await docker([
    "run", "--rm", "-d", "--name", containerName,
    "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=keepsake",
    "-p", "127.0.0.1::5432", postgresImage,
  ]);
  containerStarted = true;

  const portOutput = await docker(["port", containerName, "5432/tcp"]);
  const pgPort = portOutput.stdout.trim().split(":").pop();
  const adminUrl = `postgres://postgres:postgres@127.0.0.1:${pgPort}/keepsake`;
  await waitForPostgres(adminUrl);
  process.stdout.write("  ✓ postgres is accepting connections\n");

  process.stdout.write("loading schema + catalog seed:\n");
  await runSqlFile(adminUrl, "db/schema.sql");
  await runSqlFile(adminUrl, "db/seed_catalog.sql");

  // The webhook smoke doesn't exercise RLS — the route never reads
  // current user. Run the dev server as superuser so /api/session can
  // hydrate without an explicit app-role setup; the webhook route's
  // workerTransaction picks up the same DSN.

  const ownerId = randomUUID();
  const ownerEmail = "webhook-owner@example.test";
  const ownerName = "Webhook Owner";
  const encryptionKey = Buffer.from(
    "1234567890abcdef1234567890abcdef", "utf8",
  ).toString("base64");
  await withClient(adminUrl, async (client) => {
    await client.query(
      `INSERT INTO users (id, email, display_name) VALUES ($1::uuid, $2, $3)`,
      [ownerId, ownerEmail, ownerName],
    );
  });

  // Seed deliveries in `sent` state with deterministic provider message ids.
  const providerIdDelivered = "prov-msg-delivered";
  const providerIdOpenedAfter = "prov-msg-opened-after-delivered";
  const providerIdOpenedDirect = "prov-msg-opened-direct";
  const providerIdFailed = "prov-msg-failed";
  const providerIdNoDowngrade = "prov-msg-no-downgrade";
  const providerIdFailedAfterOpen = "prov-msg-failed-after-open";

  const deliveryDeliveredId = await seedSentDelivery(adminUrl, encryptionKey, ownerId, providerIdDelivered);
  const deliveryOpenedAfterId = await seedSentDelivery(adminUrl, encryptionKey, ownerId, providerIdOpenedAfter);
  const deliveryOpenedDirectId = await seedSentDelivery(adminUrl, encryptionKey, ownerId, providerIdOpenedDirect);
  const deliveryFailedId = await seedSentDelivery(adminUrl, encryptionKey, ownerId, providerIdFailed);
  const deliveryNoDowngradeId = await seedSentDelivery(adminUrl, encryptionKey, ownerId, providerIdNoDowngrade);
  const deliveryFailedAfterOpenId = await seedSentDelivery(adminUrl, encryptionKey, ownerId, providerIdFailedAfterOpen);

  const nextBin = resolve(projectRoot, "node_modules/.bin/next");
  nextChild = spawn(nextBin, ["dev", "--port", String(port)], {
    cwd: projectRoot,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      BROWSER: "none",
      NEXT_TELEMETRY_DISABLED: "1",
      // Webhook runs under workerTransaction → the worker pool reads
      // KEEPSAKE_WORKER_DATABASE_URL (or falls back to DATABASE_URL).
      // This smoke doesn't exercise RLS so we share a single
      // superuser DSN for both pools.
      DATABASE_URL: adminUrl,
      DEV_ENCRYPTION_KEY_BASE64: encryptionKey,
      DEV_OWNER_ID: ownerId,
      DEV_OWNER_EMAIL: ownerEmail,
      DEV_OWNER_NAME: ownerName,
      KEEPSAKE_DATA_SOURCE: "db",
      DELIVERY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    },
  });
  nextChild.stderr.on("data", (chunk) => { serverError += chunk.toString(); });
  nextChild.stdout.on("data", (chunk) => { serverError += chunk.toString(); });

  process.stdout.write(`booting next dev on :${port}...\n`);
  await waitForNext();
  process.stdout.write("server ready, running assertions:\n");

  // ── delivered: sent -> delivered ─────────────────────────────────
  {
    const deliveredAt = "2026-06-19T12:34:56.000Z";
    const res = await postWebhook({
      provider: "mock",
      providerMessageId: providerIdDelivered,
      event: "delivered",
      occurredAtISO: deliveredAt,
      providerStatus: "delivered-by-provider",
    });
    check("delivered event -> 200", res.status === 200, `status=${res.status}`);
    check("delivered response status=delivered",
      res.body?.status === "delivered", `body=${JSON.stringify(res.body)}`);
    check("delivered response updated=true", res.body?.updated === true);

    const row = await fetchDeliveryRow(adminUrl, deliveryDeliveredId);
    check("DB row status=delivered", row?.status === "delivered",
      `status=${row?.status}`);
    check("delivered_at stamped from event",
      row?.delivered_at?.toISOString?.() === deliveredAt
        || (row?.delivered_at && new Date(row.delivered_at).toISOString() === deliveredAt),
      `delivered_at=${row?.delivered_at}`);
    check("opened_at still null", row?.opened_at === null);
    check("provider_status persisted",
      row?.provider_status === "delivered-by-provider");

    // Idempotent re-delivery -> updated=false
    const repeat = await postWebhook({
      provider: "mock",
      providerMessageId: providerIdDelivered,
      event: "delivered",
    });
    check("repeat delivered -> 200", repeat.status === 200);
    check("repeat delivered updated=false", repeat.body?.updated === false);
    const reread = await fetchDeliveryRow(adminUrl, deliveryDeliveredId);
    check("repeat delivered did not overwrite delivered_at",
      new Date(reread.delivered_at).toISOString() === deliveredAt);
  }

  // ── opened-after-delivered: sent -> delivered -> opened ───────────
  {
    // First flip to delivered.
    await postWebhook({
      provider: "mock",
      providerMessageId: providerIdOpenedAfter,
      event: "delivered",
      occurredAtISO: "2026-06-19T10:00:00.000Z",
    });
    const openedAt = "2026-06-19T11:00:00.000Z";
    const res = await postWebhook({
      provider: "mock",
      providerMessageId: providerIdOpenedAfter,
      event: "opened",
      occurredAtISO: openedAt,
    });
    check("opened-after-delivered -> 200", res.status === 200);
    check("opened-after-delivered response status=opened",
      res.body?.status === "opened");
    const row = await fetchDeliveryRow(adminUrl, deliveryOpenedAfterId);
    check("DB row advanced to opened", row?.status === "opened");
    check("opened_at stamped",
      new Date(row.opened_at).toISOString() === openedAt);
    check("delivered_at preserved (not overwritten by opened event)",
      new Date(row.delivered_at).toISOString() === "2026-06-19T10:00:00.000Z");
  }

  // ── opened-direct: sent -> opened (skipping delivered) ────────────
  {
    const openedAt = "2026-06-19T13:00:00.000Z";
    const res = await postWebhook({
      provider: "mock",
      providerMessageId: providerIdOpenedDirect,
      event: "opened",
      occurredAtISO: openedAt,
    });
    check("opened-direct -> 200", res.status === 200);
    const row = await fetchDeliveryRow(adminUrl, deliveryOpenedDirectId);
    check("opened-direct DB status=opened", row?.status === "opened");
    check("opened-direct opened_at stamped",
      new Date(row.opened_at).toISOString() === openedAt);
    check("opened-direct delivered_at stamped from same event",
      new Date(row.delivered_at).toISOString() === openedAt);
  }

  // ── failed: sent -> failed ────────────────────────────────────────
  {
    const res = await postWebhook({
      provider: "mock",
      providerMessageId: providerIdFailed,
      event: "failed",
      failureReason: "user mailbox full",
    });
    check("failed event -> 200", res.status === 200);
    check("failed response status=failed", res.body?.status === "failed");
    const row = await fetchDeliveryRow(adminUrl, deliveryFailedId);
    check("DB row status=failed", row?.status === "failed");
    check("failure_reason persisted",
      row?.failure_reason === "user mailbox full",
      `failure_reason=${row?.failure_reason}`);
    check("delivered_at NOT stamped on failed", row?.delivered_at === null);
    check("opened_at NOT stamped on failed", row?.opened_at === null);
  }

  // ── no-downgrade: sent -> opened then delivered (no regression) ───
  {
    // First flip to opened.
    await postWebhook({
      provider: "mock",
      providerMessageId: providerIdNoDowngrade,
      event: "opened",
      occurredAtISO: "2026-06-19T09:00:00.000Z",
    });
    // Now try delivered (a late-arriving downstream event).
    const res = await postWebhook({
      provider: "mock",
      providerMessageId: providerIdNoDowngrade,
      event: "delivered",
      occurredAtISO: "2026-06-19T09:30:00.000Z",
    });
    check("late delivered after opened -> 200", res.status === 200);
    check("late delivered response status stays opened",
      res.body?.status === "opened",
      `body=${JSON.stringify(res.body)}`);
    check("late delivered updated=false", res.body?.updated === false);
    const row = await fetchDeliveryRow(adminUrl, deliveryNoDowngradeId);
    check("DB row status stays opened", row?.status === "opened");
  }

  // ── failed-after-open: opened -> failed (terminal-from-non-failed
  //    BUT not a regression from opened) ──────────────────────────────
  {
    await postWebhook({
      provider: "mock",
      providerMessageId: providerIdFailedAfterOpen,
      event: "opened",
      occurredAtISO: "2026-06-19T08:00:00.000Z",
    });
    const res = await postWebhook({
      provider: "mock",
      providerMessageId: providerIdFailedAfterOpen,
      event: "failed",
      failureReason: "should not apply post-open",
    });
    check("failed after opened -> 200 (no error to provider)",
      res.status === 200);
    check("failed after opened keeps status=opened",
      res.body?.status === "opened",
      `body=${JSON.stringify(res.body)}`);
    const row = await fetchDeliveryRow(adminUrl, deliveryFailedAfterOpenId);
    check("DB row status stays opened (failed blocked after open)",
      row?.status === "opened");
    check("failure_reason NOT recorded after open",
      row?.failure_reason === null,
      `failure_reason=${row?.failure_reason}`);
  }

  // ── unknown providerMessageId -> 404 ──────────────────────────────
  {
    const res = await postWebhook({
      provider: "mock",
      providerMessageId: "prov-msg-nope",
      event: "delivered",
    });
    check("unknown providerMessageId -> 404",
      res.status === 404, `status=${res.status}`);
    check("unknown providerMessageId code=delivery_not_found",
      res.body?.code === "delivery_not_found",
      `body=${JSON.stringify(res.body)}`);
  }

  // ── schema-level uniqueness on provider_message_id ────────────────
  // Webhook identity is `provider_message_id`. Two rows sharing the
  // same non-null value would fork the status timeline, so the
  // partial UNIQUE index must reject the duplicate at insert time —
  // independent of any application-level guard.
  {
    let conflictCode = null;
    try {
      await seedSentDelivery(
        adminUrl,
        encryptionKey,
        ownerId,
        providerIdDelivered,
      );
    } catch (error) {
      conflictCode = error?.code ?? null;
    }
    check(
      "duplicate provider_message_id INSERT rejected (SQLSTATE 23505)",
      conflictCode === "23505",
      `code=${conflictCode}`,
    );
  }

  // ── secret gate (sanity in DB mode) ───────────────────────────────
  {
    const wrong = await postWebhook(
      {
        provider: "mock",
        providerMessageId: providerIdDelivered,
        event: "delivered",
      },
      "wrong-secret",
    );
    check("wrong secret in DB mode -> 401",
      wrong.status === 401, `status=${wrong.status}`);
  }

  if (failures.length) throw new Error(`${failures.length} assertion failure(s)`);
  process.stdout.write("\nall webhook-deliveries DB checks passed\n");
} catch (error) {
  harnessError = error;
} finally {
  await stopNext();
  if (containerStarted) {
    try { await docker(["rm", "-f", containerName]); } catch {}
  }
}

if (harnessError) {
  process.stdout.write(`\nharness failed: ${harnessError?.message ?? harnessError}\n`);
  if (serverError) {
    process.stdout.write(`--- next dev stderr ---\n${serverError}\n`);
  }
  process.exit(1);
}
