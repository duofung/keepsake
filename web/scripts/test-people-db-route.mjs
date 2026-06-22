// DB-backed smoke test for /api/people. Boots a throwaway Postgres, loads the
// schema/catalog/dev fixtures, starts Next with KEEPSAKE_DATA_SOURCE=db, then
// verifies the public PeoplePayload contract through the HTTP route.
//
// Run via: pnpm test:db:people-route

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = normalize(join(__dirname, ".."));
const containerName = `keepsake-test-people-route-${Date.now()}`;
const postgresImage = "postgres:17-alpine";
const appRole = "keepsake_app";
const appPassword = "keepsake_app";
const port = Number(process.env.TEST_PORT ?? 3135);
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

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
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

async function withClient(databaseUrl, fn) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
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

  throw new Error(`Postgres did not become ready: ${lastError?.message ?? "unknown error"}`);
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
      const res = await fetch(`${base}/api/people`);
      if (res.ok) return;
      lastError = new Error(`status ${res.status}: ${await res.text()}`);
    } catch (error) {
      lastError = error;
    }
    await wait(500);
  }

  throw new Error(`Next dev did not become ready at ${base}: ${lastError?.message ?? "unknown error"}`);
}

async function getPeople() {
  const res = await fetch(`${base}/api/people`);
  const body = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body };
}

async function postPeople(body) {
  const res = await fetch(`${base}/api/people`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const payload = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body: payload };
}

const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
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
  const pgPort = portOutput.stdout.trim().split(":").pop();
  const adminUrl = `postgres://postgres:postgres@127.0.0.1:${pgPort}/keepsake`;
  const appUrl = `postgres://${appRole}:${appPassword}@127.0.0.1:${pgPort}/keepsake`;

  await waitForPostgres(adminUrl);
  process.stdout.write("  ✓ postgres is accepting connections\n");

  process.stdout.write("loading schema and catalog seed:\n");
  await runSqlFile(adminUrl, "db/schema.sql");
  await runSqlFile(adminUrl, "db/seed_catalog.sql");

  await withClient(adminUrl, async (client) => {
    await client.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${appPassword}' NOBYPASSRLS`);
    await client.query(`GRANT CONNECT ON DATABASE keepsake TO ${appRole}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);
    await client.query(`GRANT SELECT ON relationships, cultures, people, occasion_nodes TO ${appRole}`);
    await client.query(`GRANT INSERT ON people TO ${appRole}`);
    await client.query(`GRANT EXECUTE ON FUNCTION current_user_id() TO ${appRole}`);
  });

  const ownerId = randomUUID();
  const encryptionKey = randomBytes(32).toString("base64");
  const fixtureEnv = {
    ...process.env,
    DATABASE_URL: adminUrl,
    DEV_ENCRYPTION_KEY_BASE64: encryptionKey,
    DEV_OWNER_ID: ownerId,
    DEV_OWNER_EMAIL: "route-fixture@example.test",
    DEV_OWNER_NAME: "Route Fixture",
  };

  process.stdout.write("seeding dev fixtures:\n");
  await command("node", ["scripts/seed-dev-fixtures.mjs"], { env: fixtureEnv });
  process.stdout.write("  ✓ fixtures seeded\n");

  const nextBin = resolve(projectRoot, "node_modules/.bin/next");
  nextChild = spawn(nextBin, ["dev", "--port", String(port)], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      BROWSER: "none",
      DATABASE_URL: appUrl,
      DEV_ENCRYPTION_KEY_BASE64: encryptionKey,
      DEV_OWNER_ID: ownerId,
      DEV_OWNER_EMAIL: "route-fixture@example.test",
      DEV_OWNER_NAME: "Route Fixture",
      KEEPSAKE_DATA_SOURCE: "db",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });

  let serverError = "";
  nextChild.stderr.on("data", (chunk) => {
    serverError += chunk.toString();
  });

  process.stdout.write(`booting next dev on :${port} with KEEPSAKE_DATA_SOURCE=db…\n`);
  await waitForNext();
  process.stdout.write("server ready, running assertions:\n");

  const { status, body } = await getPeople();
  check("GET /api/people → 200", status === 200, `status=${status}`);
  check("response is a JSON object", body && typeof body === "object");

  const people = body?.people ?? [];
  const relationships = body?.relationships ?? [];
  const cultures = body?.cultures ?? [];
  const occasions = body?.occasions ?? [];

  check("people.length = 5", people.length === 5, `got ${people.length}`);
  check("relationships.length = 10", relationships.length === 10, `got ${relationships.length}`);
  check("cultures.length = 4", cultures.length === 4, `got ${cultures.length}`);
  check("occasions.length = 7", occasions.length === 7, `got ${occasions.length}`);

  const aisha = people.find((person) => person.name === "Aisha");
  check("Aisha present in DB payload", !!aisha);
  check("Aisha cultureId = malay-muslim", aisha?.cultureId === "malay-muslim", `got ${aisha?.cultureId}`);

  const malayMuslim = cultures.find((culture) => culture.id === "malay-muslim");
  check("malay-muslim culture present", !!malayMuslim);
  check(
    "malay-muslim festivals include hari-raya",
    Array.isArray(malayMuslim?.festivals) && malayMuslim.festivals.includes("hari-raya"),
    `festivals=${JSON.stringify(malayMuslim?.festivals)}`,
  );
  check(
    "malay-muslim taboos include 'No Christmas greetings'",
    Array.isArray(malayMuslim?.taboos) && malayMuslim.taboos.includes("No Christmas greetings"),
    `taboos=${JSON.stringify(malayMuslim?.taboos)}`,
  );

  const lin = people.find((person) => person.name === "Lin");
  check("Lin present in DB payload", !!lin);
  check("Lin has a nextOccasionId", typeof lin?.nextOccasionId === "string" && lin.nextOccasionId.length > 0);

  const linAnniv = occasions.find((occasion) => occasion.id === lin?.nextOccasionId);
  check("Lin next occasion is present", !!linAnniv);
  check("Lin next occasion belongs to Lin", linAnniv?.personId === lin?.id, `got ${linAnniv?.personId}`);
  check("Lin next occasion label = Anniversary", linAnniv?.label === "Anniversary", `got ${linAnniv?.label}`);

  const kira = people.find((person) => person.name === "Kira");
  check("Kira lastContactAt survives DB route", kira?.lastContactAt === "2026-04-14", `got ${kira?.lastContactAt}`);

  const malformed = await postPeople("{");
  check("POST /api/people malformed JSON → 400", malformed.status === 400, `status=${malformed.status}`);
  check("malformed JSON code = invalid_request", malformed.body?.code === "invalid_request", `body=${JSON.stringify(malformed.body)}`);

  const missingName = await postPeople({
    relationshipId: "rel-friend",
    cultureId: "none",
  });
  check("POST /api/people missing name → 400", missingName.status === 400, `status=${missingName.status}`);
  check("missing name code = invalid_request", missingName.body?.code === "invalid_request", `body=${JSON.stringify(missingName.body)}`);

  const invalidReference = await postPeople({
    name: "Bad Reference",
    relationshipId: "rel-not-real",
    cultureId: "none",
  });
  check("POST /api/people invalid relationship → 400", invalidReference.status === 400, `status=${invalidReference.status}`);
  check("invalid relationship code = invalid_reference", invalidReference.body?.code === "invalid_reference", `body=${JSON.stringify(invalidReference.body)}`);

  const created = await postPeople({
    name: "Helen",
    relationshipId: "rel-friend",
    cultureId: "none",
    since: "promoted today",
    note: "Prefers concise celebratory notes.",
    starred: true,
  });
  check("POST /api/people valid create → 201", created.status === 201, `status=${created.status}`);
  check("created person has DB uuid", /^[0-9a-f-]{36}$/i.test(created.body?.id ?? ""), `id=${created.body?.id}`);
  check("created person name = Helen", created.body?.name === "Helen", `got ${created.body?.name}`);
  check("created person starred = true", created.body?.starred === true, `got ${created.body?.starred}`);
  check("created person relationshipId = rel-friend", created.body?.relationshipId === "rel-friend", `got ${created.body?.relationshipId}`);
  check("created person cultureId = none", created.body?.cultureId === "none", `got ${created.body?.cultureId}`);
  check("created person known fact preserved", created.body?.knownFacts?.[0]?.text === "Prefers concise celebratory notes.", `body=${JSON.stringify(created.body)}`);

  const afterCreate = await getPeople();
  const createdInPayload = afterCreate.body?.people?.find((person) => person.id === created.body?.id);
  check("GET /api/people includes created person", !!createdInPayload);
  check("created person remains decrypted in payload", createdInPayload?.name === "Helen", `got ${createdInPayload?.name}`);
  check("people.length becomes 6 after create", afterCreate.body?.people?.length === 6, `got ${afterCreate.body?.people?.length}`);

  if (serverError && failures.length) {
    process.stdout.write(`\nnext stderr:\n${serverError}\n`);
  }
} catch (error) {
  process.stdout.write(`harness error: ${error?.message ?? error}\n`);
  failures.push("harness");
} finally {
  if (nextChild) {
    nextChild.kill("SIGTERM");
    await wait(400);
    if (!nextChild.killed) nextChild.kill("SIGKILL");
  }
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
  process.stdout.write("\nall ok\n");
  process.exit(0);
}
