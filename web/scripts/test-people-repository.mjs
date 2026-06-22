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
const containerName = `keepsake-test-people-${Date.now()}`;
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
  const tempRoot = join(projectRoot, ".next", "test-people-repository");
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

  const catalogSourcePath = join(projectRoot, "lib/repositories/catalog.server.ts");
  const catalogSource = (await readFile(catalogSourcePath, "utf8"))
    .replace(/^import "server-only";\n/, "")
    .replace(
      /from "@\/lib\/server\/db\/transaction\.server"/g,
      'from "./transaction.server.cjs"',
    );
  const catalogOutputPath = join(tempDir, "catalog.server.cjs");
  await writeFile(catalogOutputPath, transpile(catalogSourcePath, catalogSource));

  const peopleSourcePath = join(projectRoot, "lib/repositories/people.server.ts");
  const peopleSource = (await readFile(peopleSourcePath, "utf8"))
    .replace(/^import "server-only";\n/, "")
    .replace(
      /from "@\/lib\/server\/db\/transaction\.server"/g,
      'from "./transaction.server.cjs"',
    )
    .replace(
      /from "@\/lib\/server\/crypto\/envelope\.server"/g,
      'from "./envelope.server.cjs"',
    )
    .replace(/from "\.\/catalog\.server"/g, 'from "./catalog.server.cjs"');
  const peopleOutputPath = join(tempDir, "people.server.cjs");
  await writeFile(peopleOutputPath, transpile(peopleSourcePath, peopleSource));

  const require = createRequire(import.meta.url);
  const db = require(transactionOutputPath);
  const envelope = require(envelopeOutputPath);
  const peopleModule = require(peopleOutputPath);

  if (typeof db.transaction !== "function" || typeof db.query !== "function") {
    throw new Error("transaction.server.ts did not expose transaction() and query().");
  }
  if (typeof db.__closePoolForTest !== "function") {
    throw new Error("test harness could not attach a pool cleanup hook.");
  }
  if (typeof envelope.encrypt !== "function") {
    throw new Error("envelope.server.ts did not export encrypt().");
  }
  if (typeof peopleModule.createPeopleRepository !== "function") {
    throw new Error("people.server.ts did not export createPeopleRepository().");
  }

  helperClose = db.__closePoolForTest;
  return { db, encrypt: envelope.encrypt, people: peopleModule.createPeopleRepository() };
}

async function encryptedText(encrypt, ownerId, table, column, value) {
  return Buffer.from(await encrypt(ownerId, table, column, Buffer.from(value, "utf8")));
}

async function encryptedJson(encrypt, ownerId, table, column, value) {
  return encryptedText(encrypt, ownerId, table, column, JSON.stringify(value));
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
    await client.query(`GRANT INSERT ON people TO ${appRole}`);
    await client.query(`GRANT EXECUTE ON FUNCTION current_user_id() TO ${appRole}`);
  });

  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const linId = randomUUID();
  const kiraId = randomUUID();
  const ownerBPersonId = randomUUID();
  const linAnniversaryId = randomUUID();
  const linLaterId = randomUUID();
  const ownerBOccasionId = randomUUID();

  process.env.DATABASE_URL = appUrl;
  process.env.DEV_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString("base64");
  const { db, encrypt, people } = await loadRepository();

  const dates = await withClient(adminUrl, async (client) => {
    const result = await client.query(`
      SELECT
        to_char(CURRENT_DATE + 5, 'YYYY-MM-DD') AS soon,
        to_char(CURRENT_DATE + 30, 'YYYY-MM-DD') AS later,
        to_char(CURRENT_DATE - 9, 'YYYY-MM-DD') AS last_contact
    `);
    return result.rows[0];
  });

  await withClient(adminUrl, async (client) => {
    await client.query(
      `
        INSERT INTO users (id, email, display_name)
        VALUES ($1, $2, $3), ($4, $5, $6)
      `,
      [ownerA, "people-a@example.test", "People A", ownerB, "people-b@example.test", "People B"],
    );

    await client.query(
      `
        INSERT INTO people (
          id,
          owner_id,
          name_enc,
          starred,
          avatar_bg,
          avatar_fg,
          relationship_id,
          culture_id,
          since_enc,
          identity_tags_enc,
          known_facts_enc,
          personal_taboos_enc,
          last_contact_at
        )
        VALUES
          ($1, $2, $3, true,  '#DCEBFA', '#4E80B5', 'rel-partner', 'chinese',      $4,  $5,  $6,  $7,  $8),
          ($9, $2, $10, false, '#F8DCEB', '#C24E78', 'rel-friend',  'none',         NULL, $11, $12, $13, NULL),
          ($14, $15, $16, false, '#F8DCEB', '#C24E78', 'rel-friend', 'malay-muslim', NULL, $17, $18, $19, NULL)
      `,
      [
        linId,
        ownerA,
        await encryptedText(encrypt, ownerA, "people", "name_enc", "Lin"),
        await encryptedText(encrypt, ownerA, "people", "since_enc", "together 12 years"),
        await encryptedJson(encrypt, ownerA, "people", "identity_tags_enc", ["partner", "met at university"]),
        await encryptedJson(encrypt, ownerA, "people", "known_facts_enc", [
          { text: "Loves handwritten notes.", isLead: true },
          { text: "Keeps old concert tickets." },
        ]),
        await encryptedJson(encrypt, ownerA, "people", "personal_taboos_enc", ["Avoid public jokes."]),
        dates.last_contact,
        kiraId,
        await encryptedText(encrypt, ownerA, "people", "name_enc", "Kira"),
        await encryptedJson(encrypt, ownerA, "people", "identity_tags_enc", ["old friend"]),
        await encryptedJson(encrypt, ownerA, "people", "known_facts_enc", [
          { text: "Was going through a job change." },
        ]),
        await encryptedJson(encrypt, ownerA, "people", "personal_taboos_enc", []),
        ownerBPersonId,
        ownerB,
        await encryptedText(encrypt, ownerB, "people", "name_enc", "Hidden Friend"),
        await encryptedJson(encrypt, ownerB, "people", "identity_tags_enc", ["private"]),
        await encryptedJson(encrypt, ownerB, "people", "known_facts_enc", []),
        await encryptedJson(encrypt, ownerB, "people", "personal_taboos_enc", []),
      ],
    );

    await client.query(
      `
        INSERT INTO occasion_nodes (
          id,
          owner_id,
          person_id,
          kind,
          label_enc,
          detail_enc,
          date_iso
        )
        VALUES
          ($1, $2, $3, 'anniversary', $4, $5, $6),
          ($7, $2, $3, 'birthday',    $8, NULL, $9),
          ($10, $11, $12, 'hari-raya', $13, NULL, $6)
      `,
      [
        linAnniversaryId,
        ownerA,
        linId,
        await encryptedText(encrypt, ownerA, "occasion_nodes", "label_enc", "Anniversary"),
        await encryptedText(encrypt, ownerA, "occasion_nodes", "detail_enc", "12 years today"),
        dates.soon,
        linLaterId,
        await encryptedText(encrypt, ownerA, "occasion_nodes", "label_enc", "Birthday"),
        dates.later,
        ownerBOccasionId,
        ownerB,
        ownerBPersonId,
        await encryptedText(encrypt, ownerB, "occasion_nodes", "label_enc", "Hari Raya Aidilfitri"),
      ],
    );
  });

  process.stdout.write("verifying PeopleRepository read methods:\n");

  const ownerAPeople = await people.listForOwner(ownerA);
  const ownerBPeople = await people.listForOwner(ownerB);
  assertEqual(ownerAPeople.length, 2, "owner A sees their two people rows");
  assertEqual(ownerBPeople.length, 1, "owner B sees their one people row");

  const lin = ownerAPeople.find((person) => person.id === linId);
  assert(lin?.name === "Lin", "decrypts person name");
  assert(lin?.since === "together 12 years", "decrypts optional since");
  assert(lin?.identityTags.includes("met at university"), "decrypts identity tags JSON");
  assert(lin?.knownFacts[0]?.isLead === true, "decrypts known facts JSON");
  assert(lin?.personalTaboos.includes("Avoid public jokes."), "decrypts personal taboos JSON");
  assert(lin?.nextOccasionId === linAnniversaryId, "hydrates nextOccasionId from earliest future occasion");
  assert(lin?.lastContactAt === dates.last_contact, "maps lastContactAt as ISO date");

  const foundLin = await people.findById(ownerA, linId);
  const hiddenLin = await people.findById(ownerB, linId);
  assert(foundLin?.name === "Lin", "findById returns owned person");
  assert(hiddenLin === null, "findById hides another owner person");

  const linOccasions = await people.listOccasions(ownerA, linId);
  assertEqual(linOccasions.length, 2, "listOccasions returns two Lin occasions");
  assert(linOccasions[0]?.id === linAnniversaryId, "listOccasions orders by date");
  assert(linOccasions[0]?.detail === "12 years today", "decrypts occasion detail");
  assertEqual(linOccasions[0]?.daysUntil, 5, "derives occasion daysUntil");
  assert(linOccasions[0]?.isPrimary === true, "marks earliest future occasion primary");
  assert(linOccasions[1]?.isPrimary === false, "non-earliest future occasion is not primary");

  const foundOccasion = await people.findOccasionForPerson(ownerA, linId, linAnniversaryId);
  const wrongPersonOccasion = await people.findOccasionForPerson(ownerA, kiraId, linAnniversaryId);
  const wrongOwnerOccasion = await people.findOccasionForPerson(ownerB, linId, linAnniversaryId);
  assert(foundOccasion?.label === "Anniversary", "findOccasionForPerson returns owned occasion");
  assert(wrongPersonOccasion === null, "findOccasionForPerson checks person ownership");
  assert(wrongOwnerOccasion === null, "findOccasionForPerson hides another owner occasion");

  const next = await people.nextOccasionFor(ownerA, linId);
  assert(next?.id === linAnniversaryId, "nextOccasionFor returns earliest future occasion");

  const upcoming = await people.occasionsComingUp(ownerA, 14);
  assertEqual(upcoming.length, 1, "occasionsComingUp respects the day window");
  assert(upcoming[0]?.id === linAnniversaryId, "occasionsComingUp returns the due occasion");

  const payload = await people.listWithRelations(ownerA);
  assertEqual(payload.people.length, 2, "listWithRelations includes people");
  assertEqual(payload.occasions.length, 2, "listWithRelations includes owned occasions");
  assertEqual(payload.relationships.length, 10, "listWithRelations includes visible relationship catalog");
  assertEqual(payload.cultures.length, 4, "listWithRelations includes culture catalog");

  const created = await people.create(ownerA, {
    name: "Helen",
    starred: true,
    avatarBg: "#D9EAFA",
    avatarFg: "#4F83BA",
    relationshipId: "rel-friend",
    cultureId: "none",
    since: "promoted today",
    identityTags: ["promoted today"],
    knownFacts: [{ text: "Prefers concise notes.", isLead: true }],
    personalTaboos: ["No surprise parties."],
    lastContactAt: dates.soon,
  });
  assert(created.id && created.id !== linId, "create returns a fresh person id");
  assertEqual(created.name, "Helen", "create returns decrypted name");
  assert(created.starred === true, "create preserves starred");
  assertEqual(created.relationshipId, "rel-friend", "create preserves relationshipId");
  assertEqual(created.cultureId, "none", "create preserves cultureId");
  assertEqual(created.since, "promoted today", "create decrypts since");
  assert(created.identityTags.includes("promoted today"), "create decrypts identity tags");
  assert(created.knownFacts[0]?.text === "Prefers concise notes.", "create decrypts known facts");
  assert(created.personalTaboos.includes("No surprise parties."), "create decrypts personal taboos");
  assert(created.nextOccasionId === null, "create returns null nextOccasionId until dates exist");

  const foundCreated = await people.findById(ownerA, created.id);
  const hiddenCreated = await people.findById(ownerB, created.id);
  assert(foundCreated?.name === "Helen", "findById returns newly created person");
  assert(hiddenCreated === null, "newly created person stays owner-scoped");

  await db.transaction(ownerA, async (tx) => {
    const personInsideTx = await people.findById(ownerA, linId, tx);
    const payloadInsideTx = await people.listWithRelations(ownerA, tx);
    const createdInsideTx = await people.create(ownerA, {
      name: "Nina",
      starred: false,
      avatarBg: "#F7E7BE",
      avatarFg: "#B68221",
      relationshipId: "rel-close-friend",
      cultureId: "chinese",
      knownFacts: [{ text: "Met at a design review.", isLead: true }],
    }, tx);
    assert(personInsideTx?.id === linId, "read methods can reuse an explicit Tx");
    assertEqual(payloadInsideTx.people.length, 3, "listWithRelations can reuse an explicit Tx");
    assertEqual(createdInsideTx.name, "Nina", "create can reuse an explicit Tx");
  });

  process.stdout.write("\nall people repository checks passed\n");
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
