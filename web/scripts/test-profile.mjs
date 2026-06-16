// Smoke test for the Profile page. Boots `next dev` on an isolated port
// with dev auth env and verifies the rendered identity comes from
// current-user.server.ts rather than hard-coded profile copy.
//
// Run via: pnpm test:profile

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const PORT = Number(process.env.TEST_PROFILE_PORT ?? 3142);
const BASE = `http://localhost:${PORT}`;
const nextBin = resolve(projectRoot, "node_modules/.bin/next");

const testUser = {
  id: "33333333-3333-4333-8333-333333333333",
  email: "profile-fixture@example.test",
  name: "Profile Fixture",
  initials: "PF",
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
      const res = await fetch(`${BASE}/profile`);
      if (res.status < 500) return;
    } catch {}

    await wait(500);
  }

  throw new Error(`dev server did not become ready at ${BASE}`);
}

async function getProfile() {
  const res = await fetch(`${BASE}/profile`);
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

  const { status, body } = await getProfile();

  check("GET /profile -> 200", status === 200, `status=${status}`);
  check("renders current user name", body.includes(testUser.name));
  check("renders current user email", body.includes(testUser.email));
  check("renders current user initials", body.includes(testUser.initials));
  check("does not render old hard-coded email", !body.includes("arthur@keepsake.app"));
  check("sending email is not connected", body.includes("Not connected"));
  check("does not render fake connected email status", !/>Connected</.test(body));
  check("renders Connect Gmail CTA", body.includes(">Connect Gmail</a>"));
  check(
    "Connect CTA targets /api/oauth/gmail/start?returnTo=/profile",
    body.includes('href="/api/oauth/gmail/start?returnTo=/profile"'),
  );
  check(
    "mock-mode profile does not render Disconnect button",
    !body.includes(">Disconnect</button>"),
  );
  check(
    "mock-mode profile does not render Reconnect CTA",
    !body.includes(">Reconnect Gmail</a>"),
  );
  check("keeps subscription badge", body.includes("Keepsake+"));
  check("keeps Sending section", body.includes("SENDING"));
  check("keeps Preferences section", body.includes("PREFERENCES"));
  check("keeps Account section", body.includes("ACCOUNT"));
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
