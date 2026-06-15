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
const containerName = `keepsake-test-fixtures-${Date.now()}`;
const postgresImage = "postgres:17-alpine";
const appRole = "keepsake_app";
const appPassword = "keepsake_app";

let containerStarted = false;
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

async function loadDecrypt() {
  const tempRoot = join(projectRoot, ".next", "test-dev-fixtures");
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, "run-"));
  helperCleanup = () => rm(tempDir, { force: true, recursive: true });

  const envelopeSourcePath = join(projectRoot, "lib/server/crypto/envelope.server.ts");
  const envelopeSource = (await readFile(envelopeSourcePath, "utf8"))
    .replace(/^import "server-only";\n/, "");
  const envelopeOutputPath = join(tempDir, "envelope.server.cjs");
  await writeFile(envelopeOutputPath, transpile(envelopeSourcePath, envelopeSource));

  const require = createRequire(import.meta.url);
  const envelope = require(envelopeOutputPath);
  if (typeof envelope.decrypt !== "function") {
    throw new Error("envelope.server.ts did not expose decrypt().");
  }
  return envelope.decrypt;
}

async function decryptText(decrypt, ownerId, table, column, value) {
  return Buffer.from(await decrypt(ownerId, table, column, value)).toString("utf8");
}

async function decryptJson(decrypt, ownerId, table, column, value) {
  return JSON.parse(await decryptText(decrypt, ownerId, table, column, value));
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

async function countWithRls(databaseUrl, ownerId) {
  return withClient(databaseUrl, async (client) => {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [ownerId]);
    const result = await client.query("SELECT count(*)::int AS count FROM people");
    await client.query("COMMIT");
    return result.rows[0].count;
  });
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
    await client.query(`GRANT SELECT ON people TO ${appRole}`);
    await client.query(`GRANT EXECUTE ON FUNCTION current_user_id() TO ${appRole}`);
  });

  const ownerId = randomUUID();
  const ownerEmail = "fixture-owner@example.test";
  const encryptionKey = randomBytes(32).toString("base64");
  const seedEnv = {
    ...process.env,
    DATABASE_URL: adminUrl,
    DEV_ENCRYPTION_KEY_BASE64: encryptionKey,
    DEV_OWNER_ID: ownerId,
    DEV_OWNER_EMAIL: ownerEmail,
    DEV_OWNER_NAME: "Fixture Owner",
  };

  process.stdout.write("running dev fixture seed twice:\n");
  const firstRun = await command("node", ["scripts/seed-dev-fixtures.mjs"], { env: seedEnv });
  assert(firstRun.stdout.includes("seeded 5 people, 7 occasions, 4 deliveries"), "first seed reports expected fixture counts");
  const secondRun = await command("node", ["scripts/seed-dev-fixtures.mjs"], { env: seedEnv });
  assert(secondRun.stdout.includes("seeded 5 people, 7 occasions, 4 deliveries"), "second seed is idempotent");

  process.env.DEV_ENCRYPTION_KEY_BASE64 = encryptionKey;
  const decrypt = await loadDecrypt();

  process.stdout.write("verifying seeded rows:\n");
  await withClient(adminUrl, async (client) => {
    const counts = await client.query(`
      SELECT
        (SELECT count(*)::int FROM users WHERE id = $1) AS users,
        (SELECT count(*)::int FROM people WHERE owner_id = $1) AS people,
        (SELECT count(*)::int FROM occasion_nodes WHERE owner_id = $1) AS occasions,
        (SELECT count(*)::int FROM deliveries WHERE owner_id = $1) AS deliveries
    `, [ownerId]);
    assertEqual(counts.rows[0].users, 1, "seeds one owner user");
    assertEqual(counts.rows[0].people, 5, "seeds five people");
    assertEqual(counts.rows[0].occasions, 7, "seeds seven occasions");
    assertEqual(counts.rows[0].deliveries, 4, "seeds four deliveries");

    const people = await client.query(`
      SELECT name_enc, personal_taboos_enc
      FROM people
      WHERE owner_id = $1
      ORDER BY id
    `, [ownerId]);
    const names = [];
    let aishaTaboos = [];
    for (const row of people.rows) {
      const name = await decryptText(decrypt, ownerId, "people", "name_enc", row.name_enc);
      names.push(name);
      if (name === "Aisha") {
        aishaTaboos = await decryptJson(decrypt, ownerId, "people", "personal_taboos_enc", row.personal_taboos_enc);
      }
    }
    assert(names.includes("Lin") && names.includes("Aisha") && names.includes("Kira"), "decrypts seeded people names");
    assert(aishaTaboos.some((taboo) => taboo.includes("Selamat Hari Raya")), "decrypts Aisha personal taboo");

    const occasionRows = await client.query(`
      SELECT label_enc
      FROM occasion_nodes
      WHERE owner_id = $1
    `, [ownerId]);
    const occasionLabels = [];
    for (const row of occasionRows.rows) {
      occasionLabels.push(await decryptText(decrypt, ownerId, "occasion_nodes", "label_enc", row.label_enc));
    }
    assert(occasionLabels.includes("Anniversary"), "decrypts seeded anniversary occasion");
    assert(occasionLabels.includes("Hari Raya Aidilfitri"), "decrypts seeded Hari Raya occasion");

    const deliveryRows = await client.query(`
      SELECT recipient_name_enc
      FROM deliveries
      WHERE owner_id = $1
    `, [ownerId]);
    const recipientNames = [];
    for (const row of deliveryRows.rows) {
      recipientNames.push(await decryptText(decrypt, ownerId, "deliveries", "recipient_name_enc", row.recipient_name_enc));
    }
    assert(recipientNames.includes("Lin") && recipientNames.includes("Priya"), "decrypts seeded delivery recipients");
  });

  process.stdout.write("verifying fixture rows respect RLS:\n");
  assertEqual(await countWithRls(appUrl, ownerId), 5, "fixture owner sees five people through RLS");
  assertEqual(await countWithRls(appUrl, randomUUID()), 0, "another owner sees zero people through RLS");

  process.stdout.write("\nall dev fixture checks passed\n");
} catch (error) {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await helperCleanup().catch(() => {});
  if (containerStarted) {
    await docker(["stop", containerName]).catch((error) => {
      process.stderr.write(`failed to stop ${containerName}: ${error.message}\n`);
    });
  }
}
