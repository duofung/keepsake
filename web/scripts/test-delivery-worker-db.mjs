// DB-backed delivery-worker integration test.
//
// Spins up Postgres + a local Gmail stub, seeds one queued email row,
// then drives `processNextQueuedEmailDb()` directly. Asserts:
//
//   * worker returns { status: "sent", deliveryId, providerMessageId }
//   * deliveries row moves queued → sent, sent_at populated,
//     provider_message_id captured
//   * the recipient address in the Gmail send call equals the one
//     decrypted out of recipient_email_enc (so worker can't accidentally
//     pull the wrong column)
//   * the To header reflects the decrypted email
//   * a SECOND worker tick on the same DB returns nothing_to_do (no
//     double-send)
//   * an invalid_grant from the token endpoint marks delivery=failed
//     and Gmail account=expired
//   * a hard Gmail send error marks delivery=failed without touching
//     other rows
//
// Run via: pnpm test:db:delivery-worker

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, normalize } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = normalize(join(__dirname, ".."));
const require = createRequire(import.meta.url);

const containerName = `keepsake-test-delivery-worker-${Date.now()}`;
const postgresImage = "postgres:17-alpine";
const appRole = "keepsake_app";
const appPassword = "keepsake_app";
const STUB_PORT = Number(process.env.TEST_DELIVERY_WORKER_DB_STUB_PORT ?? 3181);

let containerStarted = false;
let helperCleanup = async () => {};
let helperClose = async () => {};
let stub;

function commandRun(commandName, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(commandName, args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${commandName} ${args.join(" ")} failed: ${stderr || stdout}`));
    });
  });
}
const dockerRun = (args) => commandRun("docker", args);

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
    } catch (e) {
      lastError = e;
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

function encryptToBytea(ownerId, table, column, plaintext, key32) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key32, nonce);
  cipher.setAAD(Buffer.from(`${ownerId}|${table}|${column}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

const failures = [];
function check(name, cond, detail = "") {
  if (cond) process.stdout.write(`  ✓ ${name}\n`);
  else {
    process.stdout.write(`  ✗ ${name}${detail ? `  (${detail})` : ""}\n`);
    failures.push(name);
  }
}

// ───────────────────────── Gmail stub ─────────────────────────────────
const rig = {
  tokenCalls: [],
  sendCalls: [],
  nextTokenResponse: null,
  nextSendResponse: null,
};
function startStub() {
  return new Promise((resolveStarted, reject) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        if (req.method === "POST" && req.url?.endsWith("/token")) {
          rig.tokenCalls.push({ body });
          const r = rig.nextTokenResponse ?? {
            status: 200,
            body: { access_token: "stub-access-1", token_type: "Bearer", expires_in: 3600 },
          };
          rig.nextTokenResponse = null;
          res.statusCode = r.status;
          res.setHeader("content-type", "application/json");
          res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
          return;
        }
        if (req.method === "POST" && req.url?.endsWith("/messages/send")) {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch {}
          rig.sendCalls.push({ parsed });
          const r = rig.nextSendResponse ?? {
            status: 200,
            body: { id: `gmail-msg-${rig.sendCalls.length}` },
          };
          rig.nextSendResponse = null;
          res.statusCode = r.status;
          res.setHeader("content-type", "application/json");
          res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
    });
    server.on("error", reject);
    server.listen(STUB_PORT, "127.0.0.1", () => resolveStarted(server));
  });
}
function decodeRaw(raw) {
  const padded = raw.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(raw.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

// ───────────────── Transpile + load the DB worker ────────────────────
async function loadWorker() {
  const tempRoot = join(projectRoot, ".next", "test-delivery-worker-db");
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, "run-"));
  helperCleanup = () => rm(tempDir, { force: true, recursive: true });

  async function tr(relPath, replacements = {}, appendSource = "") {
    const src = await readFile(join(projectRoot, relPath), "utf8");
    let cleaned = src.replace(/^import "server-only";\n/m, "");
    for (const [from, to] of Object.entries(replacements)) {
      cleaned = cleaned.replaceAll(`from "${from}"`, `from "${to}"`);
    }
    if (appendSource) cleaned = `${cleaned}\n${appendSource}\n`;
    const out = ts.transpileModule(cleaned, {
      fileName: relPath,
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const dest = join(tempDir, relPath.replace(/[\/\\]/g, "_").replace(/\.ts$/, ".cjs"));
    await writeFile(dest, out);
    return dest;
  }

  const envelope = await tr("lib/server/crypto/envelope.server.ts");
  // The transpiled transaction module needs explicit close hooks because
  // both pools (request + worker) live at module scope. Without these,
  // tearing down docker leaves open `pg` clients that emit unhandled
  // 'error' events when the server terminates the connection.
  const txMod = await tr(
    "lib/server/db/transaction.server.ts",
    {},
    `
export async function __closePoolForTest() {
  if (pool) { await pool.end(); pool = null; }
}
export async function __closeWorkerPoolForTest() {
  if (workerPool) { await workerPool.end(); workerPool = null; }
}
`,
  );
  const drafts = await tr("lib/repositories/drafts.server.ts", {
    "@/lib/server/db/transaction.server": txMod,
    "@/lib/server/crypto/envelope.server": envelope,
  });
  const gmailAccts = await tr("lib/repositories/gmail-accounts.server.ts", {
    "@/lib/server/db/transaction.server": txMod,
    "@/lib/server/crypto/envelope.server": envelope,
  });
  const deliveries = await tr("lib/repositories/deliveries.server.ts", {
    "@/lib/server/db/transaction.server": txMod,
    "@/lib/server/crypto/envelope.server": envelope,
  });
  const transport = await tr("lib/server/delivery-worker/gmail-transport.server.ts");
  const dbWorker = await tr("lib/server/delivery-worker/db.server.ts", {
    "@/lib/server/db/transaction.server": txMod,
    "@/lib/repositories/deliveries.server": deliveries,
    "@/lib/repositories/drafts.server": drafts,
    "@/lib/repositories/gmail-accounts.server": gmailAccts,
    "./gmail-transport.server": transport,
  });

  const txExports = require(txMod);
  helperClose = async () => {
    if (typeof txExports.__closeWorkerPoolForTest === "function") {
      await txExports.__closeWorkerPoolForTest();
    }
    if (typeof txExports.__closePoolForTest === "function") {
      await txExports.__closePoolForTest();
    }
  };
  return { processNextQueuedEmailDb: require(dbWorker).processNextQueuedEmailDb };
}

// ────────────────────────────── main ──────────────────────────────────
try {
  process.stdout.write("checking Docker availability:\n");
  await dockerRun(["--version"]);
  process.stdout.write("  ✓ docker CLI is available\n");

  process.stdout.write(`starting ${postgresImage}:\n`);
  await dockerRun([
    "run", "--rm", "-d", "--name", containerName,
    "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=keepsake",
    "-p", "127.0.0.1::5432", postgresImage,
  ]);
  containerStarted = true;

  const portOut = await dockerRun(["port", containerName, "5432/tcp"]);
  const pgPort = portOut.stdout.trim().split(":").pop();
  const adminUrl = `postgres://postgres:postgres@127.0.0.1:${pgPort}/keepsake`;
  const appUrl = `postgres://${appRole}:${appPassword}@127.0.0.1:${pgPort}/keepsake`;

  await waitForPostgres(adminUrl);
  process.stdout.write("  ✓ postgres is accepting connections\n");

  process.stdout.write("loading schema + catalog seed:\n");
  await runSqlFile(adminUrl, "db/schema.sql");
  await runSqlFile(adminUrl, "db/seed_catalog.sql");

  // App role used by the request path; the worker uses the admin URL
  // (KEEPSAKE_WORKER_DATABASE_URL) so it bypasses RLS as a worker role
  // would.
  await withClient(adminUrl, async (client) => {
    await client.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${appPassword}' NOBYPASSRLS`);
    await client.query(`GRANT CONNECT ON DATABASE keepsake TO ${appRole}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);
    await client.query(`
      GRANT USAGE ON TYPE
        relationship_kind, relationship_group, occasion_kind, tone,
        channel, delivery_status, gmail_account_status, subscription_status
      TO ${appRole}
    `);
    await client.query(`GRANT SELECT ON relationships, cultures, people, occasion_nodes TO ${appRole}`);
    await client.query(`GRANT SELECT ON gmail_accounts TO ${appRole}`);
    await client.query(`GRANT SELECT, INSERT ON message_drafts TO ${appRole}`);
    await client.query(`GRANT SELECT, INSERT ON deliveries TO ${appRole}`);
    await client.query(`GRANT EXECUTE ON FUNCTION current_user_id() TO ${appRole}`);
  });

  const ownerId = randomUUID();
  const ownerEmail = "worker-owner@example.test";
  const ownerName = "Worker Owner";
  const encryptionKey = randomBytes(32).toString("base64");
  const key32 = Buffer.from(encryptionKey, "base64");
  const senderEmail = "sender@example.test";
  const recipientEmail = "lin-worker@example.test";

  // Seed people fixtures (gives the owner Lin)
  process.stdout.write("seeding people fixtures:\n");
  await commandRun("node", ["scripts/seed-dev-fixtures.mjs"], {
    env: {
      ...process.env,
      DATABASE_URL: adminUrl,
      DEV_ENCRYPTION_KEY_BASE64: encryptionKey,
      DEV_OWNER_ID: ownerId,
      DEV_OWNER_EMAIL: ownerEmail,
      DEV_OWNER_NAME: ownerName,
    },
  });
  process.stdout.write("  ✓ fixtures seeded\n");

  // Insert a Gmail account + connected status + an opaque refresh token
  // ("stub-refresh"). The token endpoint stub accepts ANY refresh token.
  await withClient(adminUrl, async (client) => {
    const refreshEnc = encryptToBytea(
      ownerId, "gmail_accounts", "refresh_token_enc",
      "stub-refresh", key32,
    );
    await client.query(
      `
        INSERT INTO gmail_accounts (
          owner_id, email, status, scopes, is_primary,
          refresh_token_enc, last_error
        )
        VALUES ($1, $2, 'connected', $3::text[], true, $4, NULL)
      `,
      [ownerId, senderEmail,
       ["https://www.googleapis.com/auth/gmail.send", "openid", "email"],
       refreshEnc],
    );
  });

  // Insert a draft for Lin (using minimal opaque bytea) — get its uuid
  const linPersonId = await withClient(adminUrl, async (client) => {
    const r = await client.query(
      `SELECT id::text AS id FROM people WHERE owner_id = $1 LIMIT 1`,
      [ownerId],
    );
    return r.rows[0].id;
  });
  const draftSubject = "Hello from the worker test";
  const draftBody = "Hi Lin,\n\nFirst body paragraph.\n\n— always";
  const draftId = await withClient(adminUrl, async (client) => {
    const subjectEnc = encryptToBytea(
      ownerId, "message_drafts", "subject_enc", draftSubject, key32,
    );
    const paragraphsEnc = encryptToBytea(
      ownerId, "message_drafts", "paragraphs_enc",
      JSON.stringify([
        { text: "Hi Lin," },
        { text: "First body paragraph." },
        { text: "— always" },
      ]),
      key32,
    );
    const noteEnc = encryptToBytea(
      ownerId, "message_drafts", "assistant_note_enc", "n", key32,
    );
    const instructionEnc = encryptToBytea(
      ownerId, "message_drafts", "user_instruction_enc", "", key32,
    );
    const res = await client.query(
      `
        INSERT INTO message_drafts (
          owner_id, person_id, tone, tone_label, alternative_tones,
          subject_enc, paragraphs_enc, attached_card, quick_actions,
          assistant_note_enc, user_instruction_enc,
          model_provider, model_version
        )
        VALUES (
          $1, $2, 'tender-intimate', 'Tender',
          '[]'::jsonb, $3, $4, NULL, '[]'::jsonb, $5, $6, 'mock', 'mock-v1'
        )
        RETURNING id::text AS id
      `,
      [ownerId, linPersonId, subjectEnc, paragraphsEnc, noteEnc, instructionEnc],
    );
    return res.rows[0].id;
  });

  // Enqueue a queued email delivery row pointing at the draft.
  const deliveryId = await withClient(adminUrl, async (client) => {
    const nameEnc = encryptToBytea(
      ownerId, "deliveries", "recipient_name_enc", "Lin", key32,
    );
    const emailEnc = encryptToBytea(
      ownerId, "deliveries", "recipient_email_enc", recipientEmail, key32,
    );
    const labelEnc = encryptToBytea(
      ownerId, "deliveries", "occasion_label_enc", "Anniversary", key32,
    );
    const res = await client.query(
      `
        INSERT INTO deliveries (
          owner_id, person_id, draft_id, recipient_name_enc, recipient_email_enc,
          occasion_kind, occasion_label_enc, channel, status
        )
        VALUES (
          $1, $2, $3, $4, $5, 'anniversary', $6, 'email', 'queued'
        )
        RETURNING id::text AS id
      `,
      [ownerId, linPersonId, draftId, nameEnc, emailEnc, labelEnc],
    );
    return res.rows[0].id;
  });

  // Boot the Gmail stub
  stub = await startStub();
  process.stdout.write(`stub provider listening on :${STUB_PORT}\n`);

  // Configure env for the worker. We INTENTIONALLY do NOT set
  // GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET here — Phase 0 verifies the
  // worker refuses to claim a queued row when those are missing.
  process.env.DATABASE_URL = appUrl;
  process.env.KEEPSAKE_WORKER_DATABASE_URL = adminUrl;
  process.env.KEEPSAKE_DATA_SOURCE = "db";
  process.env.DEV_ENCRYPTION_KEY_BASE64 = encryptionKey;
  process.env.GOOGLE_TOKEN_ENDPOINT = `http://127.0.0.1:${STUB_PORT}/token`;
  process.env.KEEPSAKE_GMAIL_API_BASE = `http://127.0.0.1:${STUB_PORT}`;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;

  const { processNextQueuedEmailDb } = await loadWorker();

  // ── Phase 0: WORKER MISCONFIG MUST NOT BURN QUEUED ROWS ─────────────
  process.stdout.write("phase 0 — misconfigured worker does NOT consume queue:\n");
  const result0 = await processNextQueuedEmailDb();
  check("misconfig tick returns status=misconfigured",
    result0.status === "misconfigured", JSON.stringify(result0));
  check("misconfig.missing lists GOOGLE_CLIENT_ID",
    Array.isArray(result0.missing) && result0.missing.includes("GOOGLE_CLIENT_ID"));
  check("misconfig.missing lists GOOGLE_CLIENT_SECRET",
    Array.isArray(result0.missing) && result0.missing.includes("GOOGLE_CLIENT_SECRET"));
  // The queued row must be untouched: still 'queued', sent_at NULL,
  // provider_message_id NULL. The Gmail stub must not have been called.
  const untouchedRow = await withClient(adminUrl, async (client) => {
    const r = await client.query(
      `SELECT status, sent_at, provider_message_id FROM deliveries WHERE id = $1::uuid`,
      [deliveryId],
    );
    return r.rows[0];
  });
  check("queued row still status=queued after misconfig",
    untouchedRow.status === "queued", `status=${untouchedRow.status}`);
  check("queued row sent_at still NULL", untouchedRow.sent_at === null);
  check("queued row provider_message_id still NULL",
    untouchedRow.provider_message_id === null);
  check("Gmail token endpoint was NOT called", rig.tokenCalls.length === 0);
  check("Gmail send endpoint was NOT called", rig.sendCalls.length === 0);

  // Now set the env and proceed with the rest of the suite.
  process.env.GOOGLE_CLIENT_ID = "stub-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "stub-client-secret";

  // ── Phase 1: HAPPY PATH ─────────────────────────────────────────────
  process.stdout.write("phase 1 — happy path:\n");
  const result1 = await processNextQueuedEmailDb();
  check("first tick returned status=sent", result1.status === "sent", JSON.stringify(result1));
  check("first tick returned the right deliveryId", result1.deliveryId === deliveryId);
  check("first tick captured providerMessageId",
    typeof result1.providerMessageId === "string" && result1.providerMessageId.length > 0);

  // DB row inspection
  const sentRow = await withClient(adminUrl, async (client) => {
    const r = await client.query(
      `SELECT status, sent_at, provider_message_id FROM deliveries WHERE id = $1::uuid`,
      [deliveryId],
    );
    return r.rows[0];
  });
  check("DB row status now sent", sentRow.status === "sent");
  check("DB row sent_at populated", sentRow.sent_at instanceof Date);
  check("DB row provider_message_id captured",
    sentRow.provider_message_id === result1.providerMessageId);

  // Gmail send call inspection
  check("Gmail send was called exactly once", rig.sendCalls.length === 1);
  {
    const decoded = decodeRaw(rig.sendCalls[0].parsed.raw);
    check("Gmail send used the DECRYPTED recipient email",
      decoded.includes(`To: ${recipientEmail}`),
      `decoded.head=${decoded.split("\r\n").slice(0, 8).join(" | ")}`);
    check("Gmail send used the draft subject",
      decoded.includes(`Subject: ${draftSubject}`));
    check("Gmail send body contains the draft paragraph",
      decoded.includes("First body paragraph."));
    check("Gmail send From header is the connected sender",
      decoded.includes(`From: ${senderEmail}`));
  }

  // ── Phase 2: NO-DOUBLE-SEND ─────────────────────────────────────────
  process.stdout.write("phase 2 — second tick is nothing_to_do:\n");
  const sendCallsBefore = rig.sendCalls.length;
  const result2 = await processNextQueuedEmailDb();
  check("second tick returned nothing_to_do",
    result2.status === "nothing_to_do", JSON.stringify(result2));
  check("Gmail send was NOT called again", rig.sendCalls.length === sendCallsBefore);

  // ── Phase 3: TOKEN INVALID_GRANT ────────────────────────────────────
  process.stdout.write("phase 3 — invalid_grant marks delivery=failed + account=expired:\n");
  const invalidDeliveryId = await withClient(adminUrl, async (client) => {
    const nameEnc = encryptToBytea(
      ownerId, "deliveries", "recipient_name_enc", "Lin", key32);
    const emailEnc = encryptToBytea(
      ownerId, "deliveries", "recipient_email_enc", recipientEmail, key32);
    const labelEnc = encryptToBytea(
      ownerId, "deliveries", "occasion_label_enc", "Anniversary", key32);
    const r = await client.query(
      `
        INSERT INTO deliveries (
          owner_id, person_id, draft_id, recipient_name_enc, recipient_email_enc,
          occasion_kind, occasion_label_enc, channel, status
        )
        VALUES ($1, $2, $3, $4, $5, 'anniversary', $6, 'email', 'queued')
        RETURNING id::text AS id
      `,
      [ownerId, linPersonId, draftId, nameEnc, emailEnc, labelEnc],
    );
    return r.rows[0].id;
  });
  rig.nextTokenResponse = {
    status: 400,
    body: { error: "invalid_grant", error_description: "Token revoked." },
  };
  const result3 = await processNextQueuedEmailDb();
  check("invalid_grant tick returned failed",
    result3.status === "failed", JSON.stringify(result3));
  check("failure reason is token_invalid", result3.reason === "token_invalid");
  const failedRow = await withClient(adminUrl, async (client) => {
    const r = await client.query(
      `SELECT status, sent_at, provider_message_id FROM deliveries WHERE id = $1::uuid`,
      [invalidDeliveryId],
    );
    return r.rows[0];
  });
  check("DB row status now failed", failedRow.status === "failed");
  check("DB row sent_at stays NULL on failure", failedRow.sent_at === null);
  check("DB row provider_message_id stays NULL on failure",
    failedRow.provider_message_id === null);
  const accountAfter = await withClient(adminUrl, async (client) => {
    const r = await client.query(
      `SELECT status, last_error FROM gmail_accounts WHERE owner_id = $1 AND is_primary`,
      [ownerId],
    );
    return r.rows[0];
  });
  check("Gmail account moved to expired", accountAfter.status === "expired");
  check("Gmail account last_error captures the cause",
    typeof accountAfter.last_error === "string" && accountAfter.last_error.length > 0);

  // ── Phase 4: GMAIL SEND HARD ERROR ─────────────────────────────────
  process.stdout.write("phase 4 — gmail send 5xx marks delivery=failed only:\n");
  // Restore the account to connected so the worker proceeds to send.
  await withClient(adminUrl, async (client) => {
    await client.query(
      `UPDATE gmail_accounts SET status = 'connected', last_error = NULL WHERE owner_id = $1`,
      [ownerId],
    );
  });
  const gmailFailDeliveryId = await withClient(adminUrl, async (client) => {
    const nameEnc = encryptToBytea(
      ownerId, "deliveries", "recipient_name_enc", "Lin", key32);
    const emailEnc = encryptToBytea(
      ownerId, "deliveries", "recipient_email_enc", recipientEmail, key32);
    const labelEnc = encryptToBytea(
      ownerId, "deliveries", "occasion_label_enc", "Anniversary", key32);
    const r = await client.query(
      `
        INSERT INTO deliveries (
          owner_id, person_id, draft_id, recipient_name_enc, recipient_email_enc,
          occasion_kind, occasion_label_enc, channel, status
        )
        VALUES ($1, $2, $3, $4, $5, 'anniversary', $6, 'email', 'queued')
        RETURNING id::text AS id
      `,
      [ownerId, linPersonId, draftId, nameEnc, emailEnc, labelEnc],
    );
    return r.rows[0].id;
  });
  rig.nextSendResponse = {
    status: 500,
    body: { error: { code: 500, message: "Internal Server Error" } },
  };
  const result4 = await processNextQueuedEmailDb();
  check("gmail 5xx tick returned failed",
    result4.status === "failed", JSON.stringify(result4));
  check("failure reason is gmail_send_error",
    result4.reason === "gmail_send_error");
  const gmailFailRow = await withClient(adminUrl, async (client) => {
    const r = await client.query(
      `SELECT status FROM deliveries WHERE id = $1::uuid`,
      [gmailFailDeliveryId],
    );
    return r.rows[0];
  });
  check("gmail-fail row marked failed", gmailFailRow.status === "failed");
  // The originally-sent row stays sent — gmail_send_error doesn't touch it.
  const originalAfter = await withClient(adminUrl, async (client) => {
    const r = await client.query(
      `SELECT status FROM deliveries WHERE id = $1::uuid`,
      [deliveryId],
    );
    return r.rows[0];
  });
  check("originally-sent row is still sent",
    originalAfter.status === "sent");
  const accountStillConnected = await withClient(adminUrl, async (client) => {
    const r = await client.query(
      `SELECT status FROM gmail_accounts WHERE owner_id = $1 AND is_primary`,
      [ownerId],
    );
    return r.rows[0];
  });
  check("gmail account stays connected on gmail_send_error (not token failure)",
    accountStillConnected.status === "connected");

  // ── Phase 5: nothing left to do ────────────────────────────────────
  process.stdout.write("phase 5 — queue is fully drained:\n");
  const result5 = await processNextQueuedEmailDb();
  check("final tick returns nothing_to_do",
    result5.status === "nothing_to_do", JSON.stringify(result5));
} catch (error) {
  process.stderr.write(`\n${error?.message ?? String(error)}\n`);
  failures.push("harness");
} finally {
  await helperClose().catch(() => {});
  await helperCleanup().catch(() => {});
  if (stub) stub.close();
  if (containerStarted) {
    await dockerRun(["stop", containerName]).catch((e) =>
      process.stderr.write(`failed to stop ${containerName}: ${e.message}\n`),
    );
  }
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall delivery-worker DB checks passed\n");
  process.exit(0);
}
