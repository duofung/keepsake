import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = normalize(join(__dirname, ".."));
const containerName = `keepsake-test-db-${Date.now()}`;
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

async function scalar(databaseUrl, sql, values = []) {
  return withClient(databaseUrl, async (client) => {
    const result = await client.query(sql, values);
    return Number(result.rows[0].count);
  });
}

async function loadTransactionHelper() {
  const sourcePath = join(projectRoot, "lib/server/db/transaction.server.ts");
  const source = (await readFile(sourcePath, "utf8"))
    .replace(/^import "server-only";\n/, "")
    .concat(`
export async function __closePoolForTest() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
`);
  const output = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  const tempRoot = join(projectRoot, ".next", "test-db-transaction");
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, "run-"));
  const outputPath = join(tempDir, "transaction.server.cjs");
  await writeFile(outputPath, output);

  helperCleanup = () => rm(tempDir, { force: true, recursive: true });

  const require = createRequire(import.meta.url);
  const helper = require(outputPath);
  if (typeof helper.transaction !== "function") {
    throw new Error("transaction.server.ts did not export transaction().");
  }
  if (typeof helper.query !== "function") {
    throw new Error("transaction.server.ts did not export query().");
  }
  if (typeof helper.__closePoolForTest !== "function") {
    throw new Error("test harness could not attach a pool cleanup hook.");
  }
  helperClose = helper.__closePoolForTest;

  return { transaction: helper.transaction, query: helper.query };
}

async function queryInTransaction(db, ownerId, sql, values = []) {
  return db.transaction(ownerId, (tx) => db.query(tx, sql, values));
}

async function countPeople(db, ownerId) {
  const result = await queryInTransaction(
    db,
    ownerId,
    "SELECT count(*)::int AS count FROM people",
  );
  return Number(result.rows[0].count);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
  process.stdout.write(`  ✓ ${label}\n`);
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
  assertEqual(await scalar(adminUrl, "SELECT count(*)::int AS count FROM relationships"), 10, "catalog has 10 relationships");
  assertEqual(await scalar(adminUrl, "SELECT count(*)::int AS count FROM cultures"), 4, "catalog has 4 cultures");

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
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appRole}`);
    await client.query(`GRANT EXECUTE ON FUNCTION current_user_id() TO ${appRole}`);
  });

  const ownerA = randomUUID();
  const ownerB = randomUUID();

  await withClient(adminUrl, async (client) => {
    await client.query(
      `
        INSERT INTO users (id, email, display_name)
        VALUES ($1, $2, $3), ($4, $5, $6)
      `,
      [ownerA, "owner-a@example.test", "Owner A", ownerB, "owner-b@example.test", "Owner B"],
    );
  });

  process.env.DATABASE_URL = appUrl;
  const db = await loadTransactionHelper();

  process.stdout.write("verifying RLS through transaction(ownerId, fn):\n");
  await queryInTransaction(
    db,
    ownerA,
    `
      INSERT INTO people (
        owner_id,
        name_enc,
        avatar_bg,
        avatar_fg,
        relationship_id,
        culture_id,
        identity_tags_enc,
        known_facts_enc,
        personal_taboos_enc
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      ownerA,
      Buffer.from("owner-a-person"),
      "#ffffff",
      "#111111",
      "rel-friend",
      "none",
      Buffer.from("[]"),
      Buffer.from("[]"),
      Buffer.from("[]"),
    ],
  );

  assertEqual(await countPeople(db, ownerA), 1, "owner A sees their one people row");
  assertEqual(await countPeople(db, ownerB), 0, "owner B sees zero people rows");
  assertEqual(await countPeople(db, null), 0, "null owner fails closed and sees zero people rows");

  process.stdout.write("\nall db transaction checks passed\n");
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
