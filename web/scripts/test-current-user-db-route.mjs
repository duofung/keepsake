// DB-backed smoke test for CurrentUser.sendingAccount. Boots throwaway
// Postgres, seeds dev fixtures plus Gmail account rows, starts Next with
// KEEPSAKE_DATA_SOURCE=db, then verifies /api/session, Profile, and Workspace
// all receive the sender account through auth/current-user.server.ts.
//
// Run via: pnpm test:db:current-user

import { spawn } from "node:child_process";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = normalize(join(__dirname, ".."));
const containerName = `keepsake-test-current-user-db-${Date.now()}`;
const postgresImage = "postgres:17-alpine";
const appRole = "keepsake_app";
const appPassword = "keepsake_app";
const basePort = Number(process.env.TEST_CURRENT_USER_DB_PORT ?? 3146);

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

function encryptedRefreshToken(ownerId, token, encryptionKeyBase64) {
  const key = Buffer.from(encryptionKeyBase64, "base64");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${ownerId}|gmail_accounts|refresh_token_enc`, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(token, "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]);
}

async function insertUser(client, ownerId, email, name) {
  await client.query(
    `
      INSERT INTO users (id, email, display_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO UPDATE
      SET email = EXCLUDED.email,
          display_name = EXCLUDED.display_name,
          updated_at = now()
    `,
    [ownerId, email, name],
  );
}

async function insertGmailAccount(client, {
  ownerId,
  email,
  status,
  token,
  encryptionKey,
  lastError = null,
}) {
  await client.query(
    `
      INSERT INTO gmail_accounts (
        owner_id,
        email,
        status,
        scopes,
        is_primary,
        refresh_token_enc,
        last_error
      )
      VALUES ($1, $2, $3::gmail_account_status, $4::text[], true, $5, $6)
    `,
    [
      ownerId,
      email,
      status,
      ["https://www.googleapis.com/auth/gmail.send"],
      encryptedRefreshToken(ownerId, token, encryptionKey),
      lastError,
    ],
  );
}

function normalizeHtml(html) {
  return html
    .replace(/<!--\s*-->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function fetchJson(base, path) {
  const res = await fetch(`${base}${path}`);
  const body = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body };
}

async function fetchHtml(base, path) {
  const res = await fetch(`${base}${path}`);
  const body = normalizeHtml(await res.text());
  return { status: res.status, body };
}

async function waitForNext(base) {
  const deadline = Date.now() + 60_000;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/session`);
      if (res.status < 500) return;
      lastError = new Error(`status ${res.status}: ${await res.text()}`);
    } catch (error) {
      lastError = error;
    }
    await wait(500);
  }

  throw new Error(`Next dev did not become ready at ${base}: ${lastError?.message ?? "unknown error"}`);
}

async function stopNext() {
  if (!nextChild) return;

  const child = nextChild;
  nextChild = null;

  if (child.exitCode !== null || child.signalCode !== null) return;

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }

  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once("exit", () => resolvePromise(true))),
    wait(3_000).then(() => false),
  ]);

  if (!exited && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

async function withNextForOwner({
  ownerId,
  ownerEmail,
  ownerName,
  port,
  appUrl,
  encryptionKey,
}, fn) {
  const base = `http://localhost:${port}`;
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
      DEV_OWNER_EMAIL: ownerEmail,
      DEV_OWNER_NAME: ownerName,
      KEEPSAKE_DATA_SOURCE: "db",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });

  let serverError = "";
  nextChild.stderr.on("data", (chunk) => {
    serverError += chunk.toString();
  });

  try {
    process.stdout.write(`booting next dev on :${port} for ${ownerEmail}...\n`);
    await waitForNext(base);
    await fn(base);
  } catch (error) {
    if (serverError) process.stdout.write(`\nnext stderr:\n${serverError}\n`);
    throw error;
  } finally {
    await stopNext();
  }
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
    await client.query(`GRANT USAGE ON TYPE gmail_account_status TO ${appRole}`);
    await client.query(`GRANT SELECT ON relationships, cultures, people, occasion_nodes, gmail_accounts TO ${appRole}`);
    await client.query(`GRANT EXECUTE ON FUNCTION current_user_id() TO ${appRole}`);
  });

  const connectedOwner = {
    id: randomUUID(),
    email: "connected-owner@example.test",
    name: "Connected Owner",
    sender: "sender@example.test",
  };
  const expiredOwner = {
    id: randomUUID(),
    email: "expired-owner@example.test",
    name: "Expired Owner",
    sender: "expired-sender@example.test",
  };
  const emptyOwner = {
    id: randomUUID(),
    email: "empty-owner@example.test",
    name: "Empty Owner",
  };
  const encryptionKey = randomBytes(32).toString("base64");

  const fixtureEnv = {
    ...process.env,
    DATABASE_URL: adminUrl,
    DEV_ENCRYPTION_KEY_BASE64: encryptionKey,
    DEV_OWNER_ID: connectedOwner.id,
    DEV_OWNER_EMAIL: connectedOwner.email,
    DEV_OWNER_NAME: connectedOwner.name,
  };

  process.stdout.write("seeding connected owner's people fixtures:\n");
  await command("node", ["scripts/seed-dev-fixtures.mjs"], { env: fixtureEnv });
  process.stdout.write("  ✓ fixtures seeded\n");

  await withClient(adminUrl, async (client) => {
    await insertUser(client, expiredOwner.id, expiredOwner.email, expiredOwner.name);
    await insertUser(client, emptyOwner.id, emptyOwner.email, emptyOwner.name);
    await insertGmailAccount(client, {
      ownerId: connectedOwner.id,
      email: connectedOwner.sender,
      status: "connected",
      token: "connected-refresh-token",
      encryptionKey,
    });
    await insertGmailAccount(client, {
      ownerId: expiredOwner.id,
      email: expiredOwner.sender,
      status: "expired",
      token: "expired-refresh-token",
      encryptionKey,
      lastError: "refresh token expired",
    });
  });

  process.stdout.write("verifying connected account through session/profile/workspace:\n");
  await withNextForOwner({
    ownerId: connectedOwner.id,
    ownerEmail: connectedOwner.email,
    ownerName: connectedOwner.name,
    port: basePort,
    appUrl,
    encryptionKey,
  }, async (base) => {
    const session = await fetchJson(base, "/api/session");
    check("connected /api/session -> 200", session.status === 200, `status=${session.status}`);
    check(
      "session exposes connected sendingAccount",
      session.body?.user?.sendingAccount?.email === connectedOwner.sender
        && session.body.user.sendingAccount.status === "connected"
        && session.body.user.sendingAccount.provider === "gmail",
      JSON.stringify(session.body),
    );

    const profile = await fetchHtml(base, "/profile");
    check("connected /profile -> 200", profile.status === 200, `status=${profile.status}`);
    check("profile renders sender email", profile.body.includes(`Emails send from ${connectedOwner.sender}`));
    check("profile renders Connected", profile.body.includes("Connected"));

    const people = await fetchJson(base, "/api/people");
    const lin = people.body?.people?.find((person) => person.name === "Lin");
    check("connected owner has Lin fixture", !!lin);
    const workspace = await fetchHtml(base, `/workspace?person=${lin?.id ?? ""}`);
    check("connected /workspace -> 200", workspace.status === 200, `status=${workspace.status}`);
    check("workspace renders sender email", workspace.body.includes(connectedOwner.sender));
    check("workspace does not render missing sender copy", !workspace.body.includes("no sender configured"));
  });

  process.stdout.write("verifying expired account through session/profile:\n");
  await withNextForOwner({
    ownerId: expiredOwner.id,
    ownerEmail: expiredOwner.email,
    ownerName: expiredOwner.name,
    port: basePort + 1,
    appUrl,
    encryptionKey,
  }, async (base) => {
    const session = await fetchJson(base, "/api/session");
    check("expired /api/session -> 200", session.status === 200, `status=${session.status}`);
    check(
      "session exposes expired sendingAccount",
      session.body?.user?.sendingAccount?.email === expiredOwner.sender
        && session.body.user.sendingAccount.status === "expired",
      JSON.stringify(session.body),
    );

    const profile = await fetchHtml(base, "/profile");
    check("expired /profile -> 200", profile.status === 200, `status=${profile.status}`);
    check("profile renders expired sender email", profile.body.includes(`Emails send from ${expiredOwner.sender}`));
    check("profile renders Expired", profile.body.includes("Expired"));
  });

  process.stdout.write("verifying DB mode with no Gmail account:\n");
  await withNextForOwner({
    ownerId: emptyOwner.id,
    ownerEmail: emptyOwner.email,
    ownerName: emptyOwner.name,
    port: basePort + 2,
    appUrl,
    encryptionKey,
  }, async (base) => {
    const session = await fetchJson(base, "/api/session");
    check("empty /api/session -> 200", session.status === 200, `status=${session.status}`);
    check("session sendingAccount null", session.body?.user?.sendingAccount === null, JSON.stringify(session.body));

    const profile = await fetchHtml(base, "/profile");
    check("empty /profile -> 200", profile.status === 200, `status=${profile.status}`);
    check("profile renders Not connected", profile.body.includes("Not connected"));
  });
} catch (error) {
  process.stdout.write(`harness error: ${error?.message ?? error}\n`);
  failures.push("harness");
} finally {
  await stopNext();
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
  process.stdout.write("\nall current-user DB checks passed\n");
  process.exit(0);
}
