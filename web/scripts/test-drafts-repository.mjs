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
const containerName = `keepsake-test-drafts-repository-${Date.now()}`;
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
  const tempRoot = join(projectRoot, ".next", "test-drafts-repository");
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

  const draftsSourcePath = join(projectRoot, "lib/repositories/drafts.server.ts");
  const draftsSource = (await readFile(draftsSourcePath, "utf8"))
    .replace(/^import "server-only";\n/, "")
    .replace(
      /from "@\/lib\/server\/db\/transaction\.server"/g,
      'from "./transaction.server.cjs"',
    )
    .replace(
      /from "@\/lib\/server\/crypto\/envelope\.server"/g,
      'from "./envelope.server.cjs"',
    );
  const draftsOutputPath = join(tempDir, "drafts.server.cjs");
  await writeFile(draftsOutputPath, transpile(draftsSourcePath, draftsSource));

  const require = createRequire(import.meta.url);
  const db = require(transactionOutputPath);
  const envelope = require(envelopeOutputPath);
  const draftsModule = require(draftsOutputPath);

  if (typeof db.transaction !== "function" || typeof db.query !== "function") {
    throw new Error("transaction.server.ts did not expose transaction() and query().");
  }
  if (typeof db.__closePoolForTest !== "function") {
    throw new Error("test harness could not attach a pool cleanup hook.");
  }
  if (typeof envelope.decrypt !== "function") {
    throw new Error("envelope.server.ts did not expose decrypt().");
  }
  if (typeof draftsModule.createDraftRepository !== "function") {
    throw new Error("drafts.server.ts did not export createDraftRepository().");
  }

  helperClose = db.__closePoolForTest;
  return {
    db,
    decrypt: envelope.decrypt,
    drafts: draftsModule.createDraftRepository(),
  };
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

function makeInput({ personId, occasionId, promptHash, subject, userInstruction = "" }) {
  return {
    personId,
    occasionId,
    tone: userInstruction.toLowerCase().includes("flirty") ? "playful" : "tender-intimate",
    toneLabel: userInstruction.toLowerCase().includes("flirty") ? "Playful" : "Tender & intimate",
    alternativeTones: [
      { tone: "playful", label: "Playful" },
      { tone: "heartfelt", label: "Heartfelt" },
    ],
    subject,
    paragraphs: [
      { text: "Lin," },
      { text: "A saved repository draft.", highlights: ["saved"] },
    ],
    attachedCard: {
      styleLabel: "A designed card",
      description: "Tender rose tones",
      paletteHint: "rose",
      iconHint: "i-heart",
    },
    quickActions: [
      { label: "Shorter", prompt: "Shorter", iconHint: "i-edit" },
    ],
    assistantNote: `Saved ${subject}`,
    userInstruction,
    promptHash,
    modelProvider: "mock",
    modelVersion: "repository-test:v1",
  };
}

async function decryptText(decrypt, ownerId, column, value) {
  return Buffer.from(
    await decrypt(ownerId, "message_drafts", column, value),
  ).toString("utf8");
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
        relationship_kind,
        relationship_group,
        occasion_kind,
        tone,
        channel,
        delivery_status,
        subscription_status
      TO ${appRole}
    `);
    await client.query(`GRANT SELECT ON relationships, cultures, people, occasion_nodes TO ${appRole}`);
    await client.query(`GRANT SELECT, INSERT ON message_drafts TO ${appRole}`);
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
    DEV_OWNER_EMAIL: "drafts-repository-fixture@example.test",
    DEV_OWNER_NAME: "Drafts Repository Fixture",
  };

  process.stdout.write("seeding dev fixtures:\n");
  await command("node", ["scripts/seed-dev-fixtures.mjs"], { env: seedEnv });
  process.stdout.write("  ✓ fixtures seeded\n");

  const fixtureIds = await withClient(adminUrl, async (client) => {
    const result = await client.query(
      `
        SELECT p.id::text AS person_id, o.id::text AS occasion_id
        FROM people p
        JOIN occasion_nodes o
          ON o.owner_id = p.owner_id
         AND o.person_id = p.id
        WHERE p.owner_id = $1
        ORDER BY p.created_at ASC, p.id ASC, o.date_iso ASC, o.id ASC
        LIMIT 1
      `,
      [ownerId],
    );
    return result.rows[0];
  });

  assert(
    typeof fixtureIds?.person_id === "string" && typeof fixtureIds?.occasion_id === "string",
    "resolved fixture person and occasion ids",
  );

  process.env.DATABASE_URL = appUrl;
  process.env.DEV_ENCRYPTION_KEY_BASE64 = encryptionKey;
  const { db, decrypt, drafts } = await loadRepository();

  const personId = fixtureIds.person_id;
  const occasionId = fixtureIds.occasion_id;

  process.stdout.write("verifying DraftRepository:\n");

  const first = await drafts.save(ownerId, makeInput({
    personId,
    occasionId,
    promptHash: "hash-initial",
    subject: "Initial repository draft",
  }));

  assert(/^[0-9a-f-]{36}$/i.test(first.id), "save returns DB uuid id");
  assertEqual(first.personId, personId, "save maps personId");
  assertEqual(first.occasionId, occasionId, "save maps occasionId");
  assertEqual(first.subject, "Initial repository draft", "save decrypts subject");
  assertEqual(first.paragraphs[1]?.highlights?.[0], "saved", "save decrypts paragraph JSON");
  assertEqual(first.attachedCard?.paletteHint, "rose", "save maps attached_card JSON");
  assertEqual(first.quickActions[0]?.prompt, "Shorter", "save maps quick_actions JSON");

  const cached = await drafts.findByPromptHash(ownerId, "hash-initial");
  assertEqual(cached?.id, first.id, "findByPromptHash returns cached draft");
  assertEqual(cached?.assistantNote, "Saved Initial repository draft", "findByPromptHash decrypts assistant note");

  const raw = await withClient(adminUrl, async (client) => {
    const result = await client.query(
      `
        SELECT subject_enc, paragraphs_enc, assistant_note_enc, user_instruction_enc
        FROM message_drafts
        WHERE id = $1
      `,
      [first.id],
    );
    return result.rows[0];
  });

  assert(!raw.subject_enc.toString("utf8").includes("Initial repository draft"), "subject_enc stores ciphertext");
  assertEqual(
    await decryptText(decrypt, ownerId, "subject_enc", raw.subject_enc),
    first.subject,
    "subject_enc decrypts with message_drafts AAD",
  );
  assertEqual(
    JSON.parse(await decryptText(decrypt, ownerId, "paragraphs_enc", raw.paragraphs_enc))[1]?.text,
    "A saved repository draft.",
    "paragraphs_enc decrypts with message_drafts AAD",
  );
  assertEqual(
    await decryptText(decrypt, ownerId, "assistant_note_enc", raw.assistant_note_enc),
    first.assistantNote,
    "assistant_note_enc decrypts with message_drafts AAD",
  );
  assertEqual(
    await decryptText(decrypt, ownerId, "user_instruction_enc", raw.user_instruction_enc),
    "",
    "user_instruction_enc decrypts with message_drafts AAD",
  );

  await delay(20);
  const second = await drafts.save(ownerId, makeInput({
    personId,
    occasionId,
    promptHash: "hash-newer",
    subject: "Newer explicit occasion draft",
    userInstruction: "Make it more flirty",
  }));

  const latestExplicit = await drafts.getLatestFor(ownerId, personId, occasionId);
  assertEqual(latestExplicit?.id, second.id, "getLatestFor returns newest explicit occasion draft");

  await delay(20);
  const nullOccasion = await drafts.save(ownerId, makeInput({
    personId,
    occasionId: null,
    promptHash: "hash-null-occasion",
    subject: "Null occasion draft",
  }));

  const latestNull = await drafts.getLatestFor(ownerId, personId, null);
  assertEqual(latestNull?.id, nullOccasion.id, "getLatestFor uses IS NULL for null occasionId");

  const newestTwo = await drafts.listForPerson(ownerId, personId, 2);
  assertEqual(newestTwo.length, 2, "listForPerson respects limit");
  assertEqual(newestTwo[0]?.id, nullOccasion.id, "listForPerson orders newest first");
  assertEqual(newestTwo[1]?.id, second.id, "listForPerson keeps reverse chronological order");

  const hiddenByHash = await drafts.findByPromptHash(otherOwnerId, "hash-initial");
  const hiddenLatest = await drafts.getLatestFor(otherOwnerId, personId, occasionId);
  const hiddenList = await drafts.listForPerson(otherOwnerId, personId, 10);
  assert(hiddenByHash === null, "other owner findByPromptHash sees null");
  assert(hiddenLatest === null, "other owner getLatestFor sees null");
  assertEqual(hiddenList.length, 0, "other owner listForPerson sees empty");

  await db.transaction(ownerId, async (tx) => {
    const txDraft = await drafts.save(ownerId, makeInput({
      personId,
      occasionId,
      promptHash: "hash-explicit-tx",
      subject: "Explicit transaction draft",
    }), tx);
    const txCacheHit = await drafts.findByPromptHash(ownerId, "hash-explicit-tx", tx);
    assertEqual(txCacheHit?.id, txDraft.id, "explicit Tx reuse sees uncommitted draft");
  });

  const committedTxDraft = await drafts.findByPromptHash(ownerId, "hash-explicit-tx");
  assert(committedTxDraft !== null, "explicit Tx draft committed");

  process.stdout.write("\nall drafts repository checks passed\n");
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
