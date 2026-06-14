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
const containerName = `keepsake-test-catalog-${Date.now()}`;
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
  const tempRoot = join(projectRoot, ".next", "test-catalog-repository");
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

  const catalogSourcePath = join(projectRoot, "lib/repositories/catalog.server.ts");
  const catalogSource = (await readFile(catalogSourcePath, "utf8"))
    .replace(/^import "server-only";\n/, "")
    .replace(
      /from "@\/lib\/server\/db\/transaction\.server"/g,
      'from "./transaction.server.cjs"',
    );
  const catalogOutputPath = join(tempDir, "catalog.server.cjs");
  await writeFile(catalogOutputPath, transpile(catalogSourcePath, catalogSource));

  const require = createRequire(import.meta.url);
  const db = require(transactionOutputPath);
  const catalogModule = require(catalogOutputPath);

  if (typeof db.transaction !== "function" || typeof db.query !== "function") {
    throw new Error("transaction.server.ts did not expose transaction() and query().");
  }
  if (typeof db.__closePoolForTest !== "function") {
    throw new Error("test harness could not attach a pool cleanup hook.");
  }
  if (typeof catalogModule.createCatalogRepository !== "function") {
    throw new Error("catalog.server.ts did not export createCatalogRepository().");
  }

  helperClose = db.__closePoolForTest;
  return { db, catalog: catalogModule.createCatalogRepository() };
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
    await client.query(`GRANT SELECT ON relationships, cultures TO ${appRole}`);
  });

  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const customRelationshipId = `rel-u-${ownerA.slice(0, 8)}`;

  await withClient(adminUrl, async (client) => {
    await client.query(
      `
        INSERT INTO users (id, email, display_name)
        VALUES ($1, $2, $3), ($4, $5, $6)
      `,
      [ownerA, "catalog-a@example.test", "Catalog A", ownerB, "catalog-b@example.test", "Catalog B"],
    );
    await client.query(
      `
        INSERT INTO relationships (
          id,
          kind,
          group_name,
          label,
          palette_bg,
          palette_fg,
          owner_id
        )
        VALUES ($1, 'other', 'Friends', 'Inside joke', '#EFEFEF', '#5A6573', $2)
      `,
      [customRelationshipId, ownerA],
    );
  });

  process.env.DATABASE_URL = appUrl;
  const { db, catalog } = await loadRepository();

  process.stdout.write("verifying CatalogRepository:\n");

  const ownerARelationships = await catalog.listRelationships(ownerA);
  const ownerBRelationships = await catalog.listRelationships(ownerB);
  assertEqual(ownerARelationships.length, 11, "owner A sees system relationships plus their custom row");
  assertEqual(ownerBRelationships.length, 10, "owner B sees only system relationships");
  assert(
    ownerARelationships.some((rel) => rel.id === customRelationshipId && rel.label === "Inside joke"),
    "owner A list includes their custom relationship",
  );
  assert(
    !ownerBRelationships.some((rel) => rel.id === customRelationshipId),
    "owner B list excludes owner A custom relationship",
  );

  const partner = await catalog.getRelationship(ownerA, "rel-partner");
  assert(partner?.kind === "partner" && partner.group === "Partner", "system relationship maps to domain shape");

  const ownerACustom = await catalog.getRelationship(ownerA, customRelationshipId);
  const ownerBCustom = await catalog.getRelationship(ownerB, customRelationshipId);
  assert(ownerACustom?.label === "Inside joke", "owner A can get their custom relationship by id");
  assert(ownerBCustom === null, "owner B cannot get owner A custom relationship by id");

  const cultures = await catalog.listCultures();
  assertEqual(cultures.length, 4, "listCultures returns 4 system cultures");

  const malayMuslim = await catalog.getCulture("malay-muslim");
  assert(malayMuslim?.festivals.includes("hari-raya"), "malay-muslim festivals include hari-raya");
  assert(malayMuslim?.greetings.includes("Selamat Hari Raya"), "malay-muslim greetings map from SQL arrays");
  assert(malayMuslim?.taboos.includes("No Christmas greetings"), "malay-muslim taboos map from SQL arrays");

  await db.transaction(ownerA, async (tx) => {
    const relInsideTx = await catalog.getRelationship(ownerA, customRelationshipId, tx);
    const culturesInsideTx = await catalog.listCultures(tx);
    assert(relInsideTx?.id === customRelationshipId, "repository methods can reuse an explicit Tx");
    assertEqual(culturesInsideTx.length, 4, "listCultures can reuse an explicit Tx");
  });

  process.stdout.write("\nall catalog repository checks passed\n");
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
