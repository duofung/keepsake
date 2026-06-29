// Smoke test for the Home page. Boots `next dev` on an isolated port with
// dev auth env and verifies the greeting comes from current-user.server.ts
// while the existing mock-backed Home data still renders.
//
// Run via: pnpm test:home

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const PORT = Number(process.env.TEST_HOME_PORT ?? 3143);
const BASE = `http://localhost:${PORT}`;
const nextBin = resolve(projectRoot, "node_modules/.bin/next");

const testUser = {
  id: "44444444-4444-4444-8444-444444444444",
  email: "home-fixture@example.test",
  name: "Home Fixture",
};

const SESSION_SECRET = "test-home-app-session-secret-min-32-chars-ok";
let sessionCookie = "";

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
      const res = await fetch(BASE);
      if (res.status < 500) return;
    } catch {}

    await wait(500);
  }

  throw new Error(`dev server did not become ready at ${BASE}`);
}

async function getHome() {
  const res = await fetch(BASE, {
    headers: sessionCookie ? { cookie: `keepsake_session=${sessionCookie}` } : {},
  });
  const text = await res.text();
  return { status: res.status, body: normalize(text) };
}

async function mintSession() {
  const res = await fetch(`${BASE}/api/auth/dev-session/start`, {
    method: "POST",
  });
  if (res.status !== 200) {
    throw new Error(`dev-session/start failed: status=${res.status}`);
  }
  const setCookie = res.headers.get("set-cookie") ?? "";
  sessionCookie = setCookie.match(/keepsake_session=([^;]+)/)?.[1] ?? "";
  if (!sessionCookie) throw new Error("dev-session/start did not set a cookie");
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
    APP_SESSION_SIGNING_SECRET: SESSION_SECRET,
    ENABLE_DEV_SESSION_ROUTES: "1",
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
  await mintSession();
  process.stdout.write("server ready, running assertions:\n");

  const { status, body } = await getHome();

  check("GET / -> 200", status === 200, `status=${status}`);
  check("renders current user greeting", body.includes(`Good evening, ${testUser.name}`));
  check("does not render old hard-coded greeting", !body.includes("Good evening, Arthur"));
  check(
    "renders relationship intelligence framing",
    body.includes("ReMaster intelligence")
      && body.includes("Relationship profiles need attention")
      && body.includes("active profiles")
      && body.includes("need maintenance"),
  );
  check(
    "renders relationship profile overview section",
    body.includes('data-testid="relationship-profile-overview"')
      && body.includes("Relationship profile overview")
      && body.includes("Clients / prospects")
      && body.includes("Partners")
      && body.includes("Investors")
      && body.includes("Personal"),
  );
  check(
    "renders priority relationships section",
    body.includes('data-testid="priority-relationships"')
      && body.includes("Priority relationships")
      && body.includes("One reason to act"),
  );
  check(
    "renders recent relationship signals section",
    body.includes('data-testid="recent-relationship-signals"')
      && body.includes("Recent relationship signals")
      && body.includes("Small signals, next action"),
  );
  check(
    "renders missing-profile signal",
    body.includes("Needs context") || body.includes("Needs business context"),
  );
  check(
    "renders quiet relationship signal",
    body.includes("Going quiet") && body.includes("No touchpoint in"),
  );
  check(
    "renders next-action CTAs",
    body.includes("Open profile") && body.includes("Draft outreach"),
  );
  check(
    "priority relationships bridge to profile and workspace",
    body.includes("/people?review=p-kira")
      && body.includes("/workspace?person=p-kira"),
  );
  check(
    "renders recent signal copy from existing data",
    body.includes("Lin opened your last note")
      && body.includes("has no next follow-up set")
      && body.includes("has cultural context to respect"),
  );
  check(
    "old milestone dashboard copy is replaced",
    !body.includes("Track upcoming milestones, recent outreach")
      && !body.includes("FOLLOW-UP DASHBOARD")
      && !body.includes("TOUCHPOINTS TO REVIEW"),
  );
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
