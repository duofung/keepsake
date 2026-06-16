import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = normalize(join(__dirname, ".."));
const containerName = `keepsake-test-deliveries-${Date.now()}`;
const postgresImage = "postgres:17-alpine";
const appRole = "keepsake_app";
const appPassword = "keepsake_app";

let containerStarted = false;
let helperClose = async () => {};
let helperCleanup = async () => {};

function command(commandName, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(
          `${commandName} ${args.join(" ")} failed with exit code ${code}\n${stderr || stdout}`,
        ));
      }
    });
  });
}

async function docker(args) {
  return command("docker", args);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      await delay(500);
    }
  }

  throw new Error(`Postgres did not become ready: ${lastError?.message ?? "unknown error"}`);
}

async function withClient(databaseUrl, fn) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function runSqlFile(databaseUrl, path) {
  const sql = await readFile(join(projectRoot, path), "utf8");
  await withClient(databaseUrl, (client) => client.query(sql));
}

function transpile(sourcePath, source) {
  return ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

async function loadRepository() {
  const tempRoot = join(projectRoot, ".next", "test-deliveries-repository");
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, "run-"));
  helperCleanup = () => rm(tempDir, { force: true, recursive: true });

  const transactionSourcePath = join(projectRoot, "lib/server/db/transaction.server.ts");
  const transactionSource = (await readFile(transactionSourcePath, "utf8"))
    .replace(/^import "server-only";\n/, "")
    .concat(`
export async function __closePoolForTest() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
`);
  const transactionOutputPath = join(tempDir, "transaction.server.cjs");
  await writeFile(transactionOutputPath, transpile(transactionSourcePath, transactionSource));

  const envelopeSourcePath = join(projectRoot, "lib/server/crypto/envelope.server.ts");
  const envelopeSource = (await readFile(envelopeSourcePath, "utf8"))
    .replace(/^import "server-only";\n/, "");
  const envelopeOutputPath = join(tempDir, "envelope.server.cjs");
  await writeFile(envelopeOutputPath, transpile(envelopeSourcePath, envelopeSource));

  const deliveriesSourcePath = join(projectRoot, "lib/repositories/deliveries.server.ts");
  const deliveriesSource = (await readFile(deliveriesSourcePath, "utf8"))
    .replace(/^import "server-only";\n/, "")
    .replace(
      /from "@\/lib\/server\/db\/transaction\.server"/g,
      'from "./transaction.server.cjs"',
    )
    .replace(
      /from "@\/lib\/server\/crypto\/envelope\.server"/g,
      'from "./envelope.server.cjs"',
    );
  const deliveriesOutputPath = join(tempDir, "deliveries.server.cjs");
  await writeFile(deliveriesOutputPath, transpile(deliveriesSourcePath, deliveriesSource));

  const require = createRequire(import.meta.url);
  const db = require(transactionOutputPath);
  const deliveriesModule = require(deliveriesOutputPath);

  if (typeof db.transaction !== "function" || typeof db.query !== "function") {
    throw new Error("transaction.server.ts did not expose transaction() and query().");
  }
  if (typeof db.__closePoolForTest !== "function") {
    throw new Error("test harness could not attach a pool cleanup hook.");
  }
  if (typeof deliveriesModule.createDeliveryRepository !== "function") {
    throw new Error("deliveries.server.ts did not export createDeliveryRepository().");
  }

  helperClose = db.__closePoolForTest;
  return { db, deliveries: deliveriesModule.createDeliveryRepository() };
}

function assert(condition, label, detail = "") {
  if (!condition) {
    throw new Error(`${label}${detail ? `: ${detail}` : ""}`);
  }
  process.stdout.write(`  ✓ ${label}\n`);
}

function assertEqual(actual, expected, label) {
  assert(actual === expected, label, `expected ${expected}, got ${actual}`);
}

try {
  process.stdout.write("checking Docker availability:\n");
  await docker(["--version"]);
  process.stdout.write("  ✓ docker CLI is available\n");

  process.stdout.write(`starting ${postgresImage}:\n`);
  await docker([
    "run",
    "--rm",
    "-d",
    "--name",
    containerName,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-e",
    "POSTGRES_DB=keepsake",
    "-p",
    "127.0.0.1::5432",
    postgresImage,
  ]);
  containerStarted = true;

  const portOutput = await docker(["port", containerName, "5432/tcp"]);
  const port = portOutput.stdout.trim().split(":").pop();
  const adminUrl = `postgres://postgres:postgres@127.0.0.1:${port}/keepsake`;
  const appUrl = `postgres://${appRole}:${appPassword}@127.0.0.1:${port}/keepsake`;

  await waitForPostgres(adminUrl);
  process.stdout.write("  ✓ postgres is accepting connections\n");

  process.stdout.write("loading schema and catalog seed:\n");
  await runSqlFile(adminUrl, "db/schema.sql");
  await runSqlFile(adminUrl, "db/seed_catalog.sql");

  await withClient(adminUrl, async (client) => {
    await client.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${appPassword}' NOBYPASSRLS`);
    await client.query(`GRANT CONNECT ON DATABASE keepsake TO ${appRole}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);
    await client.query(`
      GRANT USAGE ON TYPE
        occasion_kind,
        channel,
        delivery_status
      TO ${appRole}
    `);
    await client.query(`GRANT SELECT, INSERT ON deliveries TO ${appRole}`);
    await client.query(`GRANT EXECUTE ON FUNCTION current_user_id() TO ${appRole}`);
  });

  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  const encryptionKey = randomBytes(32).toString("base64");
  const seedEnv = {
    ...process.env,
    DATABASE_URL: adminUrl,
    DEV_ENCRYPTION_KEY_BASE64: encryptionKey,
    DEV_OWNER_ID: ownerId,
    DEV_OWNER_EMAIL: "deliveries-fixture@example.test",
    DEV_OWNER_NAME: "Deliveries Fixture",
  };

  process.stdout.write("seeding dev fixtures:\n");
  await command("node", ["scripts/seed-dev-fixtures.mjs"], { env: seedEnv });
  process.stdout.write("  ✓ fixtures seeded\n");

  process.env.DATABASE_URL = appUrl;
  process.env.DEV_ENCRYPTION_KEY_BASE64 = encryptionKey;
  const { db, deliveries } = await loadRepository();

  process.stdout.write("verifying DeliveryRepository.listByMonth:\n");
  const ownerRows = await deliveries.listByMonth(ownerId, { limit: 50 });
  const otherOwnerRows = await deliveries.listByMonth(otherOwnerId, { limit: 50 });

  assertEqual(ownerRows.length, 4, "owner sees 4 deliveries");
  assertEqual(otherOwnerRows.length, 0, "other owner sees 0 deliveries");

  const recipients = ownerRows.map((delivery) => delivery.recipientName);
  assert(
    ["Ah Ma", "Lin", "Jun", "Priya"].every((name) => recipients.includes(name)),
    "recipients include Ah Ma, Lin, Jun, Priya",
    `recipients=${JSON.stringify(recipients)}`,
  );

  assert(
    ownerRows.some((delivery) => delivery.recipientName !== "Lin" && delivery.personId === null),
    "at least one external delivery has personId null",
    `rows=${JSON.stringify(ownerRows.map((delivery) => ({
      recipientName: delivery.recipientName,
      personId: delivery.personId,
    })))}`,
  );

  const linDelivery = ownerRows.find((delivery) => delivery.recipientName === "Lin");
  assert(
    typeof linDelivery?.personId === "string" && linDelivery.personId.length > 0,
    "Lin delivery personId is string / non-null",
    `personId=${linDelivery?.personId}`,
  );

  const labels = ownerRows.map((delivery) => delivery.occasionLabel);
  assert(
    ["Lunar New Year", "Valentine's note", "Birthday", "Deepavali"].every((label) => labels.includes(label)),
    "occasion labels include Lunar New Year, Valentine's note, Birthday, Deepavali",
    `labels=${JSON.stringify(labels)}`,
  );

  const statuses = ownerRows.map((delivery) => delivery.status);
  assert(
    statuses.includes("delivered") && statuses.includes("opened"),
    "status includes delivered and opened",
    `statuses=${JSON.stringify(statuses)}`,
  );

  assert(
    ownerRows.every((delivery) => /^\d{4}-\d{2}-\d{2}$/.test(delivery.sentAtISO)),
    "sentAtISO is YYYY-MM-DD",
    `sentAtISO=${JSON.stringify(ownerRows.map((delivery) => delivery.sentAtISO))}`,
  );

  assertEqual(ownerRows[0]?.sentAtISO, "2026-03-02", "ordering first row is 2026-03-02");
  assertEqual(ownerRows[1]?.sentAtISO, "2026-02-14", "ordering second row is 2026-02-14");
  assertEqual(ownerRows[2]?.sentAtISO, "2026-01-20", "ordering third row is January 20");
  assertEqual(ownerRows[3]?.sentAtISO, "2026-01-08", "ordering fourth row is January 8");

  await db.transaction(ownerId, async (tx) => {
    const insideTx = await deliveries.listByMonth(ownerId, { limit: 50 }, tx);
    assertEqual(insideTx.length, 4, "explicit Tx reuse works");
  });

  process.stdout.write("verifying queued rows stay out of listByMonth:\n");
  // Fixtures don't seed message_drafts, but enqueue requires a real draft_id
  // (FK to message_drafts). Insert a minimal draft via the admin connection;
  // the test never decrypts it, so the bytea content is opaque filler.
  const linDraftRow = await withClient(adminUrl, async (client) => {
    const result = await client.query(
      `
        INSERT INTO message_drafts (
          owner_id, person_id, tone, tone_label,
          subject_enc, paragraphs_enc, assistant_note_enc, user_instruction_enc,
          model_provider, model_version
        )
        SELECT $1, id, 'tender-intimate', 'Tender · Intimate',
               '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea,
               'mock', 'queued-guard-test'
        FROM people
        WHERE owner_id = $1
        LIMIT 1
        RETURNING id::text AS id, person_id::text AS person_id
      `,
      [ownerId],
    );
    return result.rows[0];
  });
  assert(linDraftRow?.id && linDraftRow?.person_id, "inserted a draft to attach to the queued row");

  const queuedRecipient = "QueuedRecipient-DoNotShowInHistory";
  const queuedLabel = "QueuedLabel-DoNotShowInHistory";
  const queued = await db.transaction(ownerId, async (tx) =>
    deliveries.enqueue(
      ownerId,
      {
        personId: linDraftRow.person_id,
        occasionId: null,
        draftId: linDraftRow.id,
        recipientName: queuedRecipient,
        occasionKind: "lunar-new-year",
        occasionLabel: queuedLabel,
        channel: "email",
      },
      tx,
    ),
  );
  assertEqual(queued.status, "queued", "enqueue returns status=queued");
  assertEqual(queued.draftId, linDraftRow.id, "enqueue echoes draftId");

  const afterEnqueue = await deliveries.listByMonth(ownerId, { limit: 50 });
  assertEqual(afterEnqueue.length, 4, "listByMonth still returns 4 sent rows (queued excluded)");
  assert(
    !afterEnqueue.some((delivery) => delivery.recipientName === queuedRecipient),
    "queued recipient does not appear in listByMonth",
  );
  assert(
    !afterEnqueue.some((delivery) => delivery.occasionLabel === queuedLabel),
    "queued occasion label does not appear in listByMonth",
  );

  // Belt-and-suspenders: the row is in the table, just filtered out.
  const rawQueuedRows = await withClient(adminUrl, async (client) => {
    const result = await client.query(
      `SELECT id::text AS id, status, sent_at
       FROM deliveries
       WHERE owner_id = $1 AND status = 'queued'`,
      [ownerId],
    );
    return result.rows;
  });
  assertEqual(rawQueuedRows.length, 1, "queued row is present in the table");
  assertEqual(rawQueuedRows[0]?.sent_at, null, "queued row sent_at is null");

  process.stdout.write("\nall deliveries repository checks passed\n");
} catch (error) {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await helperClose().catch(() => {});
  await helperCleanup().catch(() => {});
  if (containerStarted) {
    await docker(["stop", containerName]).catch((error) => {
      process.stderr.write(`failed to stop ${containerName}: ${error.message}\n`);
    });
  }
}
