// DB-backed smoke test for /history. Boots a throwaway Postgres, loads the
// schema/catalog/dev fixtures, starts Next with KEEPSAKE_DATA_SOURCE=db, then
// verifies that the History page renders delivery history through RLS.
//
// Run via: pnpm test:db:history-route

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = normalize(join(__dirname, ".."));
const containerName = `keepsake-test-history-route-${Date.now()}`;
const postgresImage = "postgres:17-alpine";
const appRole = "keepsake_app";
const appPassword = "keepsake_app";
const port = Number(process.env.TEST_PORT ?? 3138);
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
      const res = await fetch(`${base}/history`);
      if (res.ok) return;
      lastError = new Error(`status ${res.status}: ${await res.text()}`);
    } catch (error) {
      lastError = error;
    }
    await wait(500);
  }

  throw new Error(`Next dev did not become ready at ${base}: ${lastError?.message ?? "unknown error"}`);
}

let sessionCookie = "";

async function mintSession() {
  const res = await fetch(`${base}/api/auth/dev-session/start`, {
    method: "POST",
  });
  if (res.status !== 200) {
    throw new Error(`dev-session/start failed: status=${res.status}`);
  }
  const setCookie = res.headers.get("set-cookie") ?? "";
  sessionCookie = setCookie.match(/keepsake_session=([^;]+)/)?.[1] ?? "";
  if (!sessionCookie) {
    throw new Error("dev-session/start returned no cookie");
  }
}

async function getHistory() {
  const res = await fetch(`${base}/history`, {
    headers: { cookie: `keepsake_session=${sessionCookie}` },
  });
  return {
    status: res.status,
    text: await res.text(),
  };
}

function normalizeHtmlText(html) {
  return html
    .replace(/<!--\s*-->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
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
        delivery_status
      TO ${appRole}
    `);
    await client.query(`GRANT SELECT ON relationships, cultures, people, occasion_nodes, deliveries TO ${appRole}`);
    // P6-A's `currentSessionUserOrThrow` hydrates `sendingAccount` from the
    // owner's primary Gmail row, even on /history. Give the app role read
    // access so the page can load.
    await client.query(`GRANT SELECT ON gmail_accounts TO ${appRole}`);
    await client.query(`GRANT EXECUTE ON FUNCTION current_user_id() TO ${appRole}`);
  });

  const ownerId = randomUUID();
  const encryptionKey = randomBytes(32).toString("base64");
  const fixtureEnv = {
    ...process.env,
    DATABASE_URL: adminUrl,
    DEV_ENCRYPTION_KEY_BASE64: encryptionKey,
    DEV_OWNER_ID: ownerId,
    DEV_OWNER_EMAIL: "history-route-fixture@example.test",
    DEV_OWNER_NAME: "History Route Fixture",
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
      DEV_OWNER_EMAIL: "history-route-fixture@example.test",
      DEV_OWNER_NAME: "History Route Fixture",
      KEEPSAKE_DATA_SOURCE: "db",
      NEXT_TELEMETRY_DISABLED: "1",
      // P6-C made /history reject env-only auth — every request needs a
      // real keepsake_session cookie. Enable the dev-session bootstrap
      // route and bind a session secret so we can mint one below.
      APP_SESSION_SIGNING_SECRET:
        "test-history-db-app-session-secret-min-32-chars",
      ENABLE_DEV_SESSION_ROUTES: "1",
    },
  });

  let serverError = "";
  nextChild.stderr.on("data", (chunk) => {
    serverError += chunk.toString();
  });

  process.stdout.write(`booting next dev on :${port} with KEEPSAKE_DATA_SOURCE=db...\n`);
  await waitForNext();
  await mintSession();
  process.stdout.write("server ready, running assertions:\n");

  const { status, text } = await getHistory();
  const normalizedText = normalizeHtmlText(text);
  check("GET /history -> 200", status === 200, `status=${status}`);
  check("contains Activity", normalizedText.includes("Activity"));
  check(
    "contains 4 activities subtitle",
    normalizedText.includes("Account/contact outreach history · 4 activities recorded"),
  );
  check("contains MARCH 2026", normalizedText.includes("MARCH 2026"));
  check("contains FEBRUARY 2026", normalizedText.includes("FEBRUARY 2026"));
  check("contains JANUARY 2026", normalizedText.includes("JANUARY 2026"));
  check("contains Ah Ma", normalizedText.includes("Ah Ma"));
  check("contains Lin", normalizedText.includes("Lin"));
  check("contains Jun", normalizedText.includes("Jun"));
  check("contains Priya", normalizedText.includes("Priya"));
  check("contains Delivered", normalizedText.includes("Delivered"));
  check("contains Opened", normalizedText.includes("Opened"));
  check("contains Failed", normalizedText.includes("Failed"));
  // The seed fixture sources its row set from `lib/mock.ts`, where Jun's
  // birthday row carries status='failed' with a non-null sent_at — so
  // `DeliveryRepository.listByMonth` (which still filters
  // `sent_at IS NOT NULL`) includes it and the History view surfaces it.
  check(
    "renders data-delivery-status=\"failed\" in DB mode",
    text.includes('data-delivery-status="failed"'),
  );

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
