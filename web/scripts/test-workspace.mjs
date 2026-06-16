// Smoke test for the Workspace page. Boots `next dev` on an isolated port
// with dev auth env and verifies the server-rendered workspace shell includes
// recipient and sender identity. Draft generation still happens through the
// existing client-side route calls.
//
// Run via: pnpm test:workspace

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const PORT = Number(process.env.TEST_WORKSPACE_PORT ?? 3144);
const BASE = `http://localhost:${PORT}`;
const nextBin = resolve(projectRoot, "node_modules/.bin/next");

const testUser = {
  id: "66666666-6666-4666-8666-666666666666",
  email: "workspace-fixture@example.test",
  name: "Workspace Fixture",
  initials: "WF",
};

function normalize(html) {
  return html
    .replace(/<!--\s*-->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function waitForReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/workspace?person=p-lin`);
      if (res.status < 500) return;
    } catch {}

    await wait(500);
  }

  throw new Error(`dev server did not become ready at ${BASE}`);
}

async function getWorkspace() {
  const res = await fetch(`${BASE}/workspace?person=p-lin`);
  const text = await res.text();
  return { status: res.status, body: normalize(text) };
}

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    process.stdout.write(`  ✗ ${name}${detail ? `  (${detail})` : ""}\n`);
    failures.push(name);
  }
}

const child = spawn(nextBin, ["dev", "--port", String(PORT)], {
  cwd: projectRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    BROWSER: "none",
    DEV_OWNER_ID: testUser.id,
    DEV_OWNER_EMAIL: testUser.email,
    DEV_OWNER_NAME: testUser.name,
    KEEPSAKE_DATA_SOURCE: "mock",
    NEXT_TELEMETRY_DISABLED: "1",
  },
});

let serverError = "";
child.stderr.on("data", (b) => { serverError += b.toString(); });
child.on("exit", (code) => {
  if (code !== null && code !== 0 && failures.length === 0 && serverError) {
    process.stdout.write(`(dev server exited with ${code})\n${serverError}\n`);
  }
});

try {
  process.stdout.write(`booting next dev on :${PORT}...\n`);
  await waitForReady();
  process.stdout.write("server ready, running assertions:\n");

  const { status, body } = await getWorkspace();

  check("GET /workspace?person=p-lin -> 200", status === 200, `status=${status}`);
  check("renders recipient header", body.includes("To Lin"));
  check("renders relationship subtitle", body.includes("Partner") && body.includes("together 12 years"));
  check("renders compose To row", body.includes("To") && body.includes("Lin"));
  check("renders sender From row", body.includes("From"));
  check("renders sender name", body.includes(testUser.name));
  check("renders sender email", body.includes(testUser.email));
  check("renders sender initials", body.includes(testUser.initials));
  check("renders missing sender configuration", body.includes("no sender configured"));
  check("keeps tone controls", body.includes("Tone:"));
  check("keeps send footer", body.includes("Send now, or schedule for the day"));
  check("renders Send email button", body.includes("Send email"));
  check("renders Mail as card button", body.includes("Mail as card"));
  // Guard against re-introducing the old fake-success copy: the queue
  // boundary now returns 202 "queued", and the UI must reflect that.
  check("no fake 'Email sent to' copy", !body.includes("Email sent to"));
  check("no fake 'On its way' copy", !body.includes("On its way to"));
  check("does not mention Gmail", !/gmail/i.test(body));
} catch (error) {
  process.stdout.write(`harness error: ${error?.message ?? error}\n`);
  if (serverError) {
    process.stdout.write(serverError);
  }
  failures.push("harness");
} finally {
  child.kill("SIGTERM");
  await wait(400);
  if (!child.killed) child.kill("SIGKILL");
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall ok\n");
  process.exit(0);
}
