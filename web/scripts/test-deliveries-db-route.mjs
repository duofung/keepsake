// DB-backed smoke for POST /api/deliveries.
//
// Boots throwaway Postgres + seeds people fixtures + flips Gmail account
// status to drive the sender precondition. Covers the full enqueue happy
// path (DB row inserted, recipient encrypted, draft id linked) plus the
// preconditions that block the queue:
//
//   * no draft yet -> 409 no_draft
//   * no sender    -> 409 sender_not_connected (email channel only)
//   * sender expired -> 409 sender_expired (email channel only)
//   * post channel ignores sender state
//   * unknown person / cross-owner -> 404 person_not_found
//   * unknown occasion -> 404 occasion_not_found
//
// Run via: pnpm test:db:deliveries-route

import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = normalize(join(__dirname, ".."));
const containerName = `keepsake-test-deliveries-route-${Date.now()}`;
const postgresImage = "postgres:17-alpine";
const appRole = "keepsake_app";
const appPassword = "keepsake_app";
const port = Number(process.env.TEST_DELIVERIES_DB_PORT ?? 3158);
const base = `http://localhost:${port}`;

let containerStarted = false;
let nextChild = null;

function command(commandName, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(commandName, args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
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

function encryptedRefreshToken(ownerId, token, encryptionKeyBase64) {
  const key = Buffer.from(encryptionKeyBase64, "base64");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${ownerId}|gmail_accounts|refresh_token_enc`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(token, "utf8")), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

function decryptRecipientName(ownerId, blob, encryptionKeyBase64) {
  const key = Buffer.from(encryptionKeyBase64, "base64");
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(12, blob.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(`${ownerId}|deliveries|recipient_name_enc`, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

async function postDeliveries(body) {
  const res = await fetch(`${base}/api/deliveries`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const respBody = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body: respBody };
}

async function postDraft(body) {
  const res = await fetch(`${base}/api/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const failures = [];
function check(name, cond, detail = "") {
  if (cond) process.stdout.write(`  ✓ ${name}\n`);
  else {
    process.stdout.write(`  ✗ ${name}${detail ? `  (${detail})` : ""}\n`);
    failures.push(name);
  }
}

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
  const appUrl = `postgres://${appRole}:${appPassword}@127.0.0.1:${pgPort}/keepsake`;

  await waitForPostgres(adminUrl);
  process.stdout.write("  ✓ postgres is accepting connections\n");

  process.stdout.write("loading schema + catalog seed:\n");
  await runSqlFile(adminUrl, "db/schema.sql");
  await runSqlFile(adminUrl, "db/seed_catalog.sql");

  await withClient(adminUrl, async (client) => {
    await client.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${appPassword}' NOBYPASSRLS`);
    await client.query(`GRANT CONNECT ON DATABASE keepsake TO ${appRole}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);
    await client.query(`
      GRANT USAGE ON TYPE
        relationship_kind,
        relationship_group,
        occasion_kind,
        tone,
        channel,
        delivery_status,
        gmail_account_status,
        subscription_status
      TO ${appRole}
    `);
    await client.query(`GRANT SELECT ON relationships, cultures, people, occasion_nodes TO ${appRole}`);
    await client.query(`GRANT SELECT ON gmail_accounts TO ${appRole}`);
    await client.query(`GRANT SELECT, INSERT ON message_drafts TO ${appRole}`);
    await client.query(`GRANT SELECT, INSERT ON deliveries TO ${appRole}`);
    await client.query(`GRANT EXECUTE ON FUNCTION current_user_id() TO ${appRole}`);
  });

  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  const ownerEmail = "deliveries-route-owner@example.test";
  const ownerName = "Deliveries Route Owner";
  const encryptionKey = randomBytes(32).toString("base64");
  const signingSecret = randomBytes(48).toString("base64");
  const senderEmail = "sender@example.test";

  // Seed people fixtures (gives the owner Lin / Mom / Aisha / Dad / Kira)
  const fixtureEnv = {
    ...process.env,
    DATABASE_URL: adminUrl,
    DEV_ENCRYPTION_KEY_BASE64: encryptionKey,
    DEV_OWNER_ID: ownerId,
    DEV_OWNER_EMAIL: ownerEmail,
    DEV_OWNER_NAME: ownerName,
  };
  process.stdout.write("seeding people fixtures:\n");
  await command("node", ["scripts/seed-dev-fixtures.mjs"], { env: fixtureEnv });
  process.stdout.write("  ✓ fixtures seeded\n");

  // Seed a second owner so we can verify cross-owner safety
  await withClient(adminUrl, async (client) => {
    await client.query(
      `INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`,
      [otherOwnerId, "other-deliveries-owner@example.test", "Other Owner"],
    );
  });

  // Boot Next dev as the seeded owner in DB mode
  const nextBin = resolve(projectRoot, "node_modules/.bin/next");
  nextChild = spawn(nextBin, ["dev", "--port", String(port)], {
    cwd: projectRoot,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      BROWSER: "none",
      DATABASE_URL: appUrl,
      DEV_ENCRYPTION_KEY_BASE64: encryptionKey,
      DEV_OWNER_ID: ownerId,
      DEV_OWNER_EMAIL: ownerEmail,
      DEV_OWNER_NAME: ownerName,
      KEEPSAKE_DATA_SOURCE: "db",
      NEXT_TELEMETRY_DISABLED: "1",
      OAUTH_STATE_SIGNING_SECRET: signingSecret,
    },
  });
  let serverError = "";
  nextChild.stderr.on("data", (chunk) => { serverError += chunk.toString(); });

  process.stdout.write(`booting next dev on :${port}...\n`);
  await waitForNext();
  process.stdout.write("server ready, running assertions:\n");

  // Resolve the seeded Lin so we have a real personId / occasionId
  const peopleRes = await fetch(`${base}/api/people`);
  const peopleBody = await peopleRes.json();
  const lin = peopleBody.people.find((p) => p.name === "Lin");
  const aisha = peopleBody.people.find((p) => p.name === "Aisha");
  check("Lin fixture present", !!lin);
  check("Aisha fixture present", !!aisha);
  if (!lin || !aisha) throw new Error("Fixture lookup failed");

  // 1. No Gmail account yet, no draft yet → email -> 409 sender_not_connected
  const noSender = await postDeliveries({
    personId: lin.id,
    occasionId: lin.nextOccasionId,
    channel: "email",
  });
  check("no sender + email -> 409", noSender.status === 409, `status=${noSender.status}`);
  check("no sender code = sender_not_connected", noSender.body?.code === "sender_not_connected");

  // 2. Post channel still needs a draft → 409 no_draft (sender bypassed)
  const noDraftPost = await postDeliveries({
    personId: lin.id,
    occasionId: lin.nextOccasionId,
    channel: "post",
  });
  check("no draft + post -> 409", noDraftPost.status === 409, `status=${noDraftPost.status}`);
  check("no draft code = no_draft", noDraftPost.body?.code === "no_draft");

  // 3. Connect a Gmail account (status=connected) and save a draft
  await withClient(adminUrl, async (client) => {
    await client.query(
      `
        INSERT INTO gmail_accounts (
          owner_id, email, status, scopes, is_primary, refresh_token_enc, last_error
        )
        VALUES ($1, $2, 'connected', $3::text[], true, $4, NULL)
      `,
      [
        ownerId,
        senderEmail,
        ["https://www.googleapis.com/auth/gmail.send", "openid", "email"],
        encryptedRefreshToken(ownerId, "refresh-token-seed", encryptionKey),
      ],
    );
  });

  // Connected but still no draft
  const stillNoDraft = await postDeliveries({
    personId: lin.id,
    occasionId: lin.nextOccasionId,
    channel: "email",
  });
  check("connected sender + no draft -> 409", stillNoDraft.status === 409);
  check("still no_draft", stillNoDraft.body?.code === "no_draft");

  // Save a draft for Lin via the real /api/drafts route
  const draft = await postDraft({
    personId: lin.id,
    occasionId: lin.nextOccasionId,
    userInstruction: "",
  });
  check("draft saved -> 200", draft.status === 200, `status=${draft.status}`);

  // 4. Email happy path
  const queued = await postDeliveries({
    personId: lin.id,
    occasionId: lin.nextOccasionId,
    channel: "email",
  });
  check("email enqueue -> 202", queued.status === 202, `status=${queued.status}`);
  check("queued.status === 'queued'", queued.body?.status === "queued");
  check("queued.personId === lin.id", queued.body?.personId === lin.id);
  check("queued.occasionId === lin.nextOccasionId", queued.body?.occasionId === lin.nextOccasionId);
  check("queued.channel === 'email'", queued.body?.channel === "email");
  check("queued.scheduledForISO === null", queued.body?.scheduledForISO === null);
  check("queued.id is a uuid", typeof queued.body?.id === "string" && queued.body.id.length === 36);
  check("queued.draftId is a uuid", typeof queued.body?.draftId === "string");

  // 5. DB row inspection
  const inserted = await withClient(adminUrl, async (client) => {
    const result = await client.query(
      `
        SELECT id::text AS id, person_id::text AS person_id, draft_id::text AS draft_id,
               status, channel, sent_at, recipient_name_enc, occasion_kind
        FROM deliveries
        WHERE owner_id = $1 AND status = 'queued'
      `,
      [ownerId],
    );
    return result.rows;
  });
  check("exactly one deliveries row inserted", inserted.length === 1, `rows=${inserted.length}`);
  check("row.status = queued", inserted[0]?.status === "queued");
  check("row.sent_at is null", inserted[0]?.sent_at === null);
  check("row.draft_id matches API response", inserted[0]?.draft_id === queued.body?.draftId);
  check("row.channel = email", inserted[0]?.channel === "email");
  check("row.recipient_name_enc is bytea", inserted[0]?.recipient_name_enc instanceof Buffer);
  check(
    "row.recipient_name_enc decrypts to Lin",
    decryptRecipientName(ownerId, inserted[0]?.recipient_name_enc, encryptionKey) === "Lin",
  );

  // 6. Post channel happy path (sender is connected; bypass should also succeed)
  const postQueued = await postDeliveries({
    personId: lin.id,
    occasionId: lin.nextOccasionId,
    channel: "post",
  });
  check("post enqueue -> 202", postQueued.status === 202, `status=${postQueued.status}`);
  check("post queued.channel === 'post'", postQueued.body?.channel === "post");

  // 7. Flip Gmail to expired
  await withClient(adminUrl, async (client) => {
    await client.query(
      `UPDATE gmail_accounts SET status = 'expired'::gmail_account_status WHERE owner_id = $1`,
      [ownerId],
    );
  });
  const expiredEmail = await postDeliveries({
    personId: lin.id,
    occasionId: lin.nextOccasionId,
    channel: "email",
  });
  check("expired + email -> 409", expiredEmail.status === 409, `status=${expiredEmail.status}`);
  check("expired code = sender_expired", expiredEmail.body?.code === "sender_expired");

  // Post still works even when sender is expired
  const expiredPost = await postDeliveries({
    personId: lin.id,
    occasionId: lin.nextOccasionId,
    channel: "post",
  });
  check("expired + post -> 202", expiredPost.status === 202, `status=${expiredPost.status}`);

  // 8. Cross-owner / unknown person UUID -> 404
  const unknown = await postDeliveries({
    personId: randomUUID(),
    occasionId: null,
    channel: "post",
  });
  check("unknown person -> 404", unknown.status === 404, `status=${unknown.status}`);
  check("unknown person code = person_not_found", unknown.body?.code === "person_not_found");

  // 9. Cross-occasion: Aisha's nextOccasionId attached to Lin should fail
  const crossOccasion = await postDeliveries({
    personId: lin.id,
    occasionId: aisha.nextOccasionId,
    channel: "post",
  });
  check("cross-person occasion -> 404", crossOccasion.status === 404);
  check("cross-occasion code = occasion_not_found", crossOccasion.body?.code === "occasion_not_found");

  if (serverError && failures.length) {
    process.stdout.write(`\nnext stderr:\n${serverError}\n`);
  }
} catch (error) {
  process.stdout.write(`harness error: ${error?.message ?? error}\n`);
  failures.push("harness");
} finally {
  await stopNext();
  if (containerStarted) {
    await docker(["stop", containerName]).catch((error) => {
      process.stderr.write(`failed to stop ${containerName}: ${error.message}\n`);
    });
  }
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall /api/deliveries DB checks passed\n");
  process.exit(0);
}
