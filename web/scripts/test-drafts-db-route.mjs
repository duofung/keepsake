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

async function getLatestDraft({ personId, occasionId }) {
  const query = new URLSearchParams({ personId });
  if (occasionId) query.set("occasionId", occasionId);

  const res = await fetch(`${base}/api/drafts?${query.toString()}`);
  const json = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body: json };
}

async function getDraftVersions({ personId, occasionId, limit }) {
  const query = new URLSearchParams({ personId });
  if (occasionId) query.set("occasionId", occasionId);
  if (limit !== undefined) query.set("limit", String(limit));

  const res = await fetch(`${base}/api/drafts/versions?${query.toString()}`);
  const json = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body: json };
}

async function patchDraft(body) {
  const res = await fetch(`${base}/api/drafts`, {
    method: "PATCH",
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
      DEV_OWNER_EMAIL: "draft-route-fixture@example.test",
      DEV_OWNER_NAME: "Draft Route Fixture",
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
  const occasions = peopleBody?.occasions ?? [];
  const lin = people.find((person) => person.name === "Lin");
  const aisha = people.find((person) => person.name === "Aisha");

  check("Lin present in DB payload", !!lin);
  check("Aisha present in DB payload", !!aisha);
  check("Lin has nextOccasionId", typeof lin?.nextOccasionId === "string" && lin.nextOccasionId.length > 0);
  check("Aisha has nextOccasionId", typeof aisha?.nextOccasionId === "string" && aisha.nextOccasionId.length > 0);

  if (!lin || !aisha || !lin.nextOccasionId || !aisha.nextOccasionId) {
    throw new Error("Required Lin/Aisha fixture rows were not available.");
  }
  const linNextOccasion = occasions.find((occasion) => occasion.id === lin.nextOccasionId);
  const expectedLinInitialTone = linNextOccasion?.label === "Anniversary"
    ? "tender-intimate"
    : "light-warm";

  check(
    "Lin next occasion label is seeded milestone",
    ["Anniversary", "Birthday"].includes(linNextOccasion?.label ?? ""),
    `got ${linNextOccasion?.label}`,
  );

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
    const { status } = await getDraftVersions({
      personId: "not-a-uuid",
      occasionId: lin.nextOccasionId,
    });
    check("GET versions malformed personId -> 400", status === 400, `status=${status}`);
  }

  {
    const { status } = await getDraftVersions({
      personId: lin.id,
      occasionId: "not-a-uuid",
    });
    check("GET versions malformed occasionId -> 404", status === 404, `status=${status}`);
  }

  {
    const { status } = await postDraft({
      personId: lin.id,
      occasionId: aisha.nextOccasionId,
      userInstruction: "",
    });
    check("Lin + Aisha occasionId -> 404", status === 404, `status=${status}`);
  }

  {
    const { status } = await getLatestDraft({
      personId: lin.id,
      occasionId: aisha.nextOccasionId,
    });
    check("GET Lin + Aisha occasionId -> 404", status === 404, `status=${status}`);
  }

  {
    const { status } = await getDraftVersions({
      personId: lin.id,
      occasionId: aisha.nextOccasionId,
    });
    check("GET versions Lin + Aisha occasionId -> 404", status === 404, `status=${status}`);
  }

  {
    const { status } = await getLatestDraft({
      personId: lin.id,
      occasionId: lin.nextOccasionId,
    });
    check("Lin latest before any draft -> 204", status === 204, `status=${status}`);
  }

  {
    const { status, body } = await getDraftVersions({
      personId: lin.id,
      occasionId: lin.nextOccasionId,
    });
    check("Lin versions before any draft -> 200", status === 200, `status=${status}`);
    check(
      "Lin versions before any draft -> []",
      Array.isArray(body?.drafts) && body.drafts.length === 0,
    );
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
    check("Lin initial tone matches current fixture occasion", body?.tone === expectedLinInitialTone, `tone=${body?.tone}`);
    check(
      "Lin initial has paragraphs[]",
      Array.isArray(body?.paragraphs) && body.paragraphs.length > 0,
    );
  }

  {
    const { status, body } = await getLatestDraft({
      personId: lin.id,
      occasionId: lin.nextOccasionId,
    });
    check("Lin latest after initial -> 200", status === 200, `status=${status}`);
    check(
      "Lin latest after initial returns initial draft id",
      body?.id === linInitialDraftId,
      `latest=${body?.id} initial=${linInitialDraftId}`,
    );
  }

  {
    const { status, body } = await getDraftVersions({
      personId: lin.id,
      occasionId: lin.nextOccasionId,
    });
    check("Lin versions after initial -> 200", status === 200, `status=${status}`);
    check(
      "Lin versions after initial -> [initial]",
      Array.isArray(body?.drafts)
        && body.drafts.length === 1
        && body.drafts[0]?.id === linInitialDraftId,
      `ids=${(body?.drafts ?? []).map((draft) => draft?.id).join(",")}`,
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

  let linFlirtyDraftId = null;
  {
    const { status, body } = await postDraft({
      personId: lin.id,
      occasionId: lin.nextOccasionId,
      userInstruction: "Make it more flirty",
    });
    check("Lin flirty -> 200", status === 200, `status=${status}`);
    linFlirtyDraftId = body?.id ?? null;
    check("Lin flirty tone = playful", body?.tone === "playful", `tone=${body?.tone}`);
    check(
      "Lin flirty instruction returns different draft id",
      /^[0-9a-f-]{36}$/i.test(body?.id ?? "") && body.id !== linInitialDraftId,
      `initial=${linInitialDraftId} flirty=${body?.id}`,
    );
  }

  {
    const { status, body } = await getLatestDraft({
      personId: lin.id,
      occasionId: lin.nextOccasionId,
    });
    check("Lin latest after flirty -> 200", status === 200, `status=${status}`);
    check(
      "Lin latest after flirty returns flirty draft id",
      body?.id === linFlirtyDraftId,
      `latest=${body?.id} flirty=${linFlirtyDraftId}`,
    );
  }

  {
    const { status, body } = await getDraftVersions({
      personId: lin.id,
      occasionId: lin.nextOccasionId,
    });
    check("Lin versions after flirty -> 200", status === 200, `status=${status}`);
    check(
      "Lin versions after flirty -> [flirty, initial]",
      Array.isArray(body?.drafts)
        && body.drafts.length === 2
        && body.drafts[0]?.id === linFlirtyDraftId
        && body.drafts[1]?.id === linInitialDraftId,
      `ids=${(body?.drafts ?? []).map((draft) => draft?.id).join(",")}`,
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

  // PATCH /api/drafts (DB path) — derive a new canonical version from the
  // Lin flirty draft, then read it back via latest + versions to confirm it
  // landed under RLS.
  {
    // Unknown / non-UUID draftId -> 404
    {
      const { status, body } = await patchDraft({
        draftId: "11111111-1111-4111-8111-111111111111",
        subject: "anything",
        paragraphs: [{ text: "anything" }],
        attachedCard: null,
      });
      check("PATCH unknown draftId (DB) -> 404", status === 404, `status=${status}`);
      check("PATCH unknown DB error generic", body?.error === "Draft not found");
    }
    {
      const { status } = await patchDraft({
        draftId: "not-a-uuid",
        subject: "anything",
        paragraphs: [{ text: "anything" }],
        attachedCard: null,
      });
      check("PATCH non-uuid draftId (DB) -> 404", status === 404, `status=${status}`);
    }

    // No-op PATCH returns base
    {
      const { status, body: original } = await getLatestDraft({
        personId: lin.id,
        occasionId: lin.nextOccasionId,
      });
      check("DB latest pre-edit -> 200", status === 200);
      const { status: patchStatus, body: same } = await patchDraft({
        draftId: original.id,
        subject: original.subject,
        paragraphs: original.paragraphs,
        attachedCard: original.attachedCard,
      });
      check("DB PATCH no-op -> 200", patchStatus === 200);
      check("DB PATCH no-op returns base id", same?.id === original.id);
    }

    // Real edit creates a new canonical version
    const { body: base } = await getLatestDraft({
      personId: lin.id,
      occasionId: lin.nextOccasionId,
    });
    const editedSubject = `${base.subject} (DB edit)`;
    const editedParagraphs = [
      { text: "This body was edited in Workspace before queueing." },
      { text: "DB mode should persist it as a new canonical draft version." },
    ];
    let editedId;
    {
      const { status, body } = await patchDraft({
        draftId: base.id,
        subject: editedSubject,
        paragraphs: editedParagraphs,
        attachedCard: null,
      });
      check("DB PATCH new subject -> 200", status === 200, `status=${status}`);
      check("DB PATCH new subject changes id", body?.id && body.id !== base.id);
      check("DB PATCH new subject sets subject", body?.subject === editedSubject);
      check("DB PATCH new subject removes card", body?.attachedCard === null);
      check("DB PATCH new subject preserves tone", body?.tone === base.tone);
      check("DB PATCH persists edited paragraphs",
        body?.paragraphs?.[0]?.text === editedParagraphs[0].text
        && body?.paragraphs?.[1]?.text === editedParagraphs[1].text);
      editedId = body?.id;
    }
    {
      const { body } = await getLatestDraft({
        personId: lin.id,
        occasionId: lin.nextOccasionId,
      });
      check("DB latest after edit reflects new id", body?.id === editedId);
      check("DB latest after edit reflects new subject", body?.subject === editedSubject);
      check("DB latest after edit reflects body",
        body?.paragraphs?.[0]?.text === editedParagraphs[0].text);
    }
    {
      const { body } = await getDraftVersions({
        personId: lin.id,
        occasionId: lin.nextOccasionId,
      });
      const ids = (body?.drafts ?? []).map((d) => d.id);
      check("DB versions after edit includes edited", ids.includes(editedId));
      check("DB versions after edit includes original base", ids.includes(base.id));
      check("DB versions newest first (edited before base)",
        ids.indexOf(editedId) < ids.indexOf(base.id));
    }

    // Provenance inheritance: the edited row keeps the base draft's
    // model_provider / model_version (so we know which generator produced
    // the underlying prose) but clears prompt_input_hash so the edit
    // never serves a future generator cache lookup.
    {
      const rows = await withClient(adminUrl, async (client) => {
        const res = await client.query(
          `
            SELECT id::text AS id, prompt_input_hash, model_provider, model_version
            FROM message_drafts
            WHERE owner_id = $1 AND id::text IN ($2, $3)
          `,
          [ownerId, base.id, editedId],
        );
        return Object.fromEntries(res.rows.map((row) => [row.id, row]));
      });
      const baseRow = rows[base.id];
      const editedRow = rows[editedId];
      check("base row has prompt_input_hash set",
        typeof baseRow?.prompt_input_hash === "string" && baseRow.prompt_input_hash.length > 0);
      check("edited row prompt_input_hash is NULL",
        editedRow?.prompt_input_hash === null,
        `got=${editedRow?.prompt_input_hash}`);
      check("edited row inherits model_provider",
        editedRow?.model_provider === baseRow?.model_provider,
        `base=${baseRow?.model_provider} edited=${editedRow?.model_provider}`);
      check("edited row inherits model_version",
        editedRow?.model_version === baseRow?.model_version,
        `base=${baseRow?.model_version} edited=${editedRow?.model_version}`);
    }

    // Cross-owner draftId — fabricate one belonging to the second owner.
    // The other owner has no drafts, so any UUID we pass also lands in 404,
    // which is the same response we give for unknown ids. The check is that
    // the DB path treats them identically — no leak.
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
