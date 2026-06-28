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

async function getPeople(view = "active") {
  const suffix = view === "active" ? "" : `?view=${encodeURIComponent(view)}`;
  const res = await fetch(`${base}/api/people${suffix}`);
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

async function patchPeople(id, body) {
  const res = await fetch(`${base}/api/people/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const payload = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body: payload };
}

async function archivePeople(id) {
  const res = await fetch(`${base}/api/people/${encodeURIComponent(id)}/archive`, {
    method: "POST",
  });
  const payload = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body: payload };
}

async function restorePeople(id) {
  const res = await fetch(`${base}/api/people/${encodeURIComponent(id)}/restore`, {
    method: "POST",
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
    await client.query(`GRANT UPDATE ON people TO ${appRole}`);
    await client.query(`GRANT EXECUTE ON FUNCTION current_user_id() TO ${appRole}`);
  });

  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  const otherPersonId = randomUUID();
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

  await withClient(adminUrl, async (client) => {
    await client.query(
      `
        INSERT INTO users (id, email, display_name)
        VALUES ($1, $2, $3)
      `,
      [otherOwnerId, "people-route-other@example.test", "People Route Other"],
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
          identity_tags_enc,
          known_facts_enc,
          personal_taboos_enc
        )
        VALUES (
          $1,
          $2,
          decode('00', 'hex'),
          false,
          '#F8DCEB',
          '#C24E78',
          'rel-friend',
          'none',
          decode('00', 'hex'),
          decode('00', 'hex'),
          decode('00', 'hex')
        )
      `,
      [otherPersonId, otherOwnerId],
    );
  });

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
  check("Lin segment = client", lin?.segment === "client", `got ${lin?.segment}`);
  check("Lin organization = Lattice Works", lin?.organization === "Lattice Works", `got ${lin?.organization}`);
  check("Lin roleTitle = Founder", lin?.roleTitle === "Founder", `got ${lin?.roleTitle}`);
  check("Lin sourceContext = Malaysia launch advisory", lin?.sourceContext === "Malaysia launch advisory", `got ${lin?.sourceContext}`);
  check("Lin has a nextOccasionId", typeof lin?.nextOccasionId === "string" && lin.nextOccasionId.length > 0);

  const linNextOccasion = occasions.find((occasion) => occasion.id === lin?.nextOccasionId);
  check("Lin next occasion is present", !!linNextOccasion);
  check("Lin next occasion belongs to Lin", linNextOccasion?.personId === lin?.id, `got ${linNextOccasion?.personId}`);
  check(
    "Lin next occasion label is seeded milestone",
    ["Anniversary", "Birthday"].includes(linNextOccasion?.label ?? ""),
    `got ${linNextOccasion?.label}`,
  );

  const kira = people.find((person) => person.name === "Kira");
  check("Kira lastContactAt survives DB route", kira?.lastContactAt === "2026-04-14", `got ${kira?.lastContactAt}`);
  check("Kira segment = prospect", kira?.segment === "prospect", `got ${kira?.segment}`);

  const updatedKira = await patchPeople(kira?.id ?? "", {
    name: "Kira Tan",
    segment: "prospect",
    organization: "Northstar Labs",
    roleTitle: "VP People Ops",
    sourceContext: "Post-event pilot follow-up",
    note: "Wants a short deck before July.",
    lastContactAt: "2026-06-20",
    nextFollowUpAt: "2026-07-08",
  });
  check("PATCH /api/people/[id] DB update → 200", updatedKira.status === 200, `status=${updatedKira.status}`);
  check("updated person name = Kira Tan", updatedKira.body?.name === "Kira Tan", `got ${updatedKira.body?.name}`);
  check("updated organization preserved", updatedKira.body?.organization === "Northstar Labs", `got ${updatedKira.body?.organization}`);
  check("updated roleTitle preserved", updatedKira.body?.roleTitle === "VP People Ops", `got ${updatedKira.body?.roleTitle}`);
  check("updated sourceContext preserved", updatedKira.body?.sourceContext === "Post-event pilot follow-up", `got ${updatedKira.body?.sourceContext}`);
  check("updated lastContactAt preserved", updatedKira.body?.lastContactAt === "2026-06-20", `got ${updatedKira.body?.lastContactAt}`);
  check("updated nextFollowUpAt preserved", updatedKira.body?.nextFollowUpAt === "2026-07-08", `got ${updatedKira.body?.nextFollowUpAt}`);
  check("updated note preserved", updatedKira.body?.knownFacts?.[0]?.text === "Wants a short deck before July.", `body=${JSON.stringify(updatedKira.body)}`);

  const invalidPatch = await patchPeople(kira?.id ?? "", { nextFollowUpAt: "2026-13-40" });
  check("PATCH /api/people/[id] invalid date → 400", invalidPatch.status === 400, `status=${invalidPatch.status}`);
  check("invalid date code = invalid_request", invalidPatch.body?.code === "invalid_request", `body=${JSON.stringify(invalidPatch.body)}`);

  const emptyPatch = await patchPeople(kira?.id ?? "", {});
  check("PATCH /api/people/[id] no fields → 400", emptyPatch.status === 400, `status=${emptyPatch.status}`);
  check("no fields code = invalid_request", emptyPatch.body?.code === "invalid_request", `body=${JSON.stringify(emptyPatch.body)}`);

  const crossOwnerPatch = await patchPeople(otherPersonId, { name: "Should Not Update" });
  check("PATCH /api/people/[id] cross-owner → 404", crossOwnerPatch.status === 404, `status=${crossOwnerPatch.status}`);
  check("cross-owner patch code = not_found", crossOwnerPatch.body?.code === "not_found", `body=${JSON.stringify(crossOwnerPatch.body)}`);

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

  const invalidSegment = await postPeople({
    name: "Bad Segment",
    segment: "vendor",
  });
  check("POST /api/people invalid segment → 400", invalidSegment.status === 400, `status=${invalidSegment.status}`);
  check("invalid segment code = invalid_request", invalidSegment.body?.code === "invalid_request", `body=${JSON.stringify(invalidSegment.body)}`);

  const created = await postPeople({
    name: "Helen",
    segment: "prospect",
    organization: "Northstar Labs",
    roleTitle: "Head of Partnerships",
    sourceContext: "Warm intro from Malaysia launch",
    relationshipId: "rel-friend",
    cultureId: "none",
    note: "Prefers concise celebratory notes.",
    starred: true,
  });
  check("POST /api/people valid create → 201", created.status === 201, `status=${created.status}`);
  check("created person has DB uuid", /^[0-9a-f-]{36}$/i.test(created.body?.id ?? ""), `id=${created.body?.id}`);
  check("created person name = Helen", created.body?.name === "Helen", `got ${created.body?.name}`);
  check("created person segment = prospect", created.body?.segment === "prospect", `got ${created.body?.segment}`);
  check("created person organization preserved", created.body?.organization === "Northstar Labs", `got ${created.body?.organization}`);
  check("created person roleTitle preserved", created.body?.roleTitle === "Head of Partnerships", `got ${created.body?.roleTitle}`);
  check("created person sourceContext preserved", created.body?.sourceContext === "Warm intro from Malaysia launch", `got ${created.body?.sourceContext}`);
  check("created person starred = true", created.body?.starred === true, `got ${created.body?.starred}`);
  check("created person relationshipId = rel-friend", created.body?.relationshipId === "rel-friend", `got ${created.body?.relationshipId}`);
  check("created person cultureId = none", created.body?.cultureId === "none", `got ${created.body?.cultureId}`);
  check("created person known fact preserved", created.body?.knownFacts?.[0]?.text === "Prefers concise celebratory notes.", `body=${JSON.stringify(created.body)}`);

  const afterCreate = await getPeople();
  const createdInPayload = afterCreate.body?.people?.find((person) => person.id === created.body?.id);
  check("GET /api/people includes created person", !!createdInPayload);
  check("created person remains decrypted in payload", createdInPayload?.name === "Helen", `got ${createdInPayload?.name}`);
  check("created business fields remain decrypted in payload", createdInPayload?.organization === "Northstar Labs", `got ${createdInPayload?.organization}`);
  check("people.length becomes 6 after create", afterCreate.body?.people?.length === 6, `got ${afterCreate.body?.people?.length}`);

  const archived = await archivePeople(kira?.id ?? "");
  check("POST /api/people/[id]/archive DB → 200", archived.status === 200, `status=${archived.status}`);
  check("archive returns archivedAt", typeof archived.body?.person?.archivedAt === "string", `body=${JSON.stringify(archived.body)}`);

  const crossOwnerArchive = await archivePeople(otherPersonId);
  check("POST /api/people/[id]/archive cross-owner → 404", crossOwnerArchive.status === 404, `status=${crossOwnerArchive.status}`);
  check("cross-owner archive code = not_found", crossOwnerArchive.body?.code === "not_found", `body=${JSON.stringify(crossOwnerArchive.body)}`);

  const archivedAgain = await archivePeople(kira?.id ?? "");
  check("POST /api/people/[id]/archive already archived → 404", archivedAgain.status === 404, `status=${archivedAgain.status}`);

  const afterArchive = await getPeople();
  check(
    "archived person leaves DB people payload",
    !afterArchive.body?.people?.some((person) => person.id === kira?.id),
  );
  check("people.length returns to 5 after archive", afterArchive.body?.people?.length === 5, `got ${afterArchive.body?.people?.length}`);

  const archivedPayload = await getPeople("archived");
  const archivedKira = archivedPayload.body?.people?.find((person) => person.id === kira?.id);
  check("GET /api/people?view=archived → 200", archivedPayload.status === 200, `status=${archivedPayload.status}`);
  check("archived DB view includes Kira", archivedKira?.name === "Kira Tan", `body=${JSON.stringify(archivedPayload.body)}`);
  check("archived DB view keeps archivedAt", typeof archivedKira?.archivedAt === "string", `body=${JSON.stringify(archivedKira)}`);

  const crossOwnerRestore = await restorePeople(otherPersonId);
  check("POST /api/people/[id]/restore cross-owner → 404", crossOwnerRestore.status === 404, `status=${crossOwnerRestore.status}`);
  check("cross-owner restore code = not_found", crossOwnerRestore.body?.code === "not_found", `body=${JSON.stringify(crossOwnerRestore.body)}`);

  const restoreActive = await restorePeople(created.body?.id ?? "");
  check("POST /api/people/[id]/restore active person → 400", restoreActive.status === 400, `status=${restoreActive.status}`);
  check("restore active code = invalid_request", restoreActive.body?.code === "invalid_request", `body=${JSON.stringify(restoreActive.body)}`);

  const restored = await restorePeople(kira?.id ?? "");
  check("POST /api/people/[id]/restore DB → 200", restored.status === 200, `status=${restored.status}`);
  check("restore returns active Kira", restored.body?.person?.id === kira?.id && !restored.body?.person?.archivedAt, `body=${JSON.stringify(restored.body)}`);

  const afterRestore = await getPeople();
  check(
    "restored person reappears in active DB people payload",
    afterRestore.body?.people?.some((person) => person.id === kira?.id),
  );
  check("people.length returns to 6 after restore", afterRestore.body?.people?.length === 6, `got ${afterRestore.body?.people?.length}`);

  const archivedAfterRestore = await getPeople("archived");
  check(
    "restored person leaves DB archived view",
    !archivedAfterRestore.body?.people?.some((person) => person.id === kira?.id),
  );

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
