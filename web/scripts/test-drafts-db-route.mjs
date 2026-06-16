// DB-backed smoke test for /api/drafts. Boots a throwaway Postgres, loads the
// schema/catalog/dev fixtures, starts Next with KEEPSAKE_DATA_SOURCE=db, then
// verifies that draft context is hydrated through repositories/RLS while the
// existing mock draft generator still produces the MessageDraft. In DB mode,
// /api/drafts also persists message_drafts and reuses cached prompt hashes.
//
// Run via: pnpm test:db:drafts-route

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = normalize(join(__dirname, ".."));
const containerName = `keepsake-test-drafts-route-${Date.now()}`;
const postgresImage = "postgres:17-alpine";
const appRole = "keepsake_app";
const appPassword = "keepsake_app";
const port = Number(process.env.TEST_PORT ?? 3137);
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

async function postDraft(body) {
  const res = await fetch(`${base}/api/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body: json };
}

function draftText(draft) {
  const paragraphs = Array.isArray(draft?.paragraphs)
    ? draft.paragraphs.map((paragraph) => paragraph?.text ?? "")
    : [];
  return [
    draft?.subject ?? "",
    ...paragraphs,
    draft?.assistantNote ?? "",
  ].join(" ");
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
  const encryptionKey = randomBytes(32).toString("base64");
  const fixtureEnv = {
    ...process.env,
    DATABASE_URL: adminUrl,
    DEV_ENCRYPTION_KEY_BASE64: encryptionKey,
    DEV_OWNER_ID: ownerId,
    DEV_OWNER_EMAIL: "draft-route-fixture@example.test",
    DEV_OWNER_NAME: "Draft Route Fixture",
  };

  process.stdout.write("seeding dev fixtures:\n");
  await command("node", ["scripts/seed-dev-fixtures.mjs"], { env: fixtureEnv });
  process.stdout.write("  ✓ fixtures seeded\n");

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
      KEEPSAKE_DATA_SOURCE: "db",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });

  let serverError = "";
  nextChild.stderr.on("data", (chunk) => {
    serverError += chunk.toString();
  });

  process.stdout.write(`booting next dev on :${port} with KEEPSAKE_DATA_SOURCE=db...\n`);
  await waitForNext();
  process.stdout.write("server ready, resolving DB fixture ids:\n");

  const { status: peopleStatus, body: peopleBody } = await getPeople();
  check("GET /api/people -> 200", peopleStatus === 200, `status=${peopleStatus}`);

  const people = peopleBody?.people ?? [];
  const lin = people.find((person) => person.name === "Lin");
  const aisha = people.find((person) => person.name === "Aisha");

  check("Lin present in DB payload", !!lin);
  check("Aisha present in DB payload", !!aisha);
  check("Lin has nextOccasionId", typeof lin?.nextOccasionId === "string" && lin.nextOccasionId.length > 0);
  check("Aisha has nextOccasionId", typeof aisha?.nextOccasionId === "string" && aisha.nextOccasionId.length > 0);

  if (!lin || !aisha || !lin.nextOccasionId || !aisha.nextOccasionId) {
    throw new Error("Required Lin/Aisha fixture rows were not available.");
  }

  process.stdout.write("running draft assertions:\n");

  {
    const { status } = await postDraft({});
    check("{} -> 400", status === 400, `status=${status}`);
  }

  {
    const { status } = await postDraft({
      personId: randomUUID(),
      occasionId: null,
      userInstruction: "",
    });
    check("random uuid personId -> 404", status === 404, `status=${status}`);
  }

  {
    const { status } = await postDraft({
      personId: lin.id,
      occasionId: aisha.nextOccasionId,
      userInstruction: "",
    });
    check("Lin + Aisha occasionId -> 404", status === 404, `status=${status}`);
  }

  let linInitialDraftId = null;
  {
    const { status, body } = await postDraft({
      personId: lin.id,
      occasionId: lin.nextOccasionId,
      userInstruction: "",
    });
    check("Lin explicit next occasion -> 200", status === 200, `status=${status}`);
    linInitialDraftId = body?.id ?? null;
    check("Lin initial returns DB uuid id", /^[0-9a-f-]{36}$/i.test(linInitialDraftId ?? ""));
    check("Lin initial tone = tender-intimate", body?.tone === "tender-intimate", `tone=${body?.tone}`);
    check(
      "Lin initial has paragraphs[]",
      Array.isArray(body?.paragraphs) && body.paragraphs.length > 0,
    );
  }

  {
    const { status, body } = await postDraft({
      personId: lin.id,
      occasionId: lin.nextOccasionId,
      userInstruction: "",
    });
    check("Lin repeated same input -> 200", status === 200, `status=${status}`);
    check(
      "Lin repeated same input returns same draft id (cache hit)",
      body?.id === linInitialDraftId,
      `first=${linInitialDraftId} second=${body?.id}`,
    );
  }

  {
    const { body } = await postDraft({
      personId: lin.id,
      occasionId: lin.nextOccasionId,
      userInstruction: "Make it more flirty",
    });
    check("Lin flirty tone = playful", body?.tone === "playful", `tone=${body?.tone}`);
    check(
      "Lin flirty instruction returns different draft id",
      /^[0-9a-f-]{36}$/i.test(body?.id ?? "") && body.id !== linInitialDraftId,
      `initial=${linInitialDraftId} flirty=${body?.id}`,
    );
  }

  {
    const { status, body } = await postDraft({
      personId: aisha.id,
      occasionId: aisha.nextOccasionId,
      userInstruction: "",
    });
    check("Aisha explicit next occasion -> 200", status === 200, `status=${status}`);
    check("Aisha tone = warm-festive", body?.tone === "warm-festive", `tone=${body?.tone}`);

    const haystack = draftText(body);
    check(
      "Aisha draft contains no Christmas reference",
      !/christmas|x-?mas/i.test(haystack),
      `haystack=${haystack.slice(0, 80)}...`,
    );
    check("Aisha draft contains Selamat Hari Raya", /selamat hari raya/i.test(haystack));
  }

  {
    const { status } = await postDraft({
      personId: lin.id,
      occasionId: null,
      userInstruction: "",
    });
    check("Lin omitted occasionId fallback -> 200", status === 200, `status=${status}`);
  }

  if (serverError && failures.length) {
    process.stdout.write(`\nnext stderr:\n${serverError}\n`);
  }
} catch (error) {
  process.stdout.write(`harness error: ${error?.message ?? error}\n`);
  failures.push("harness");
} finally {
  if (nextChild) {
    try {
      process.kill(-nextChild.pid, "SIGTERM");
    } catch {}
    await wait(400);
    try {
      process.kill(-nextChild.pid, "SIGKILL");
    } catch {}
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
