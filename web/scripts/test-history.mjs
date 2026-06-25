// Smoke test for the History page. Boots `next dev` on an isolated port,
// requests GET /history, and asserts the rendered HTML matches the mock
// delivery data through the ReMaster compatibility framing. No DB, no LLM —
// just a regression net so that swapping the delivery-history seam later can't
// quietly break the History view.
//
// Run via: pnpm test:history

import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const PORT = Number(process.env.TEST_PORT ?? 3134);
const BASE = `http://localhost:${PORT}`;

const SESSION_SECRET = "test-history-app-session-secret-min-32-chars";
const TEST_USER = {
  id: "77777777-7777-4777-8777-777777777777",
  email: "history-fixture@example.test",
  name: "History Fixture",
};
let sessionCookie = "";

// React encodes apostrophes as `&#x27;` in attributes and stitches text
// segments around interpolated values with empty HTML comments
// (`Hello<!-- -->4<!-- --> world`). Normalize both so substring assertions
// match what a reader of the rendered page actually sees.
function normalize(html) {
  return html
    .replace(/<!--\s*-->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function getHistory() {
  const res = await fetch(`${BASE}/history`, {
    headers: sessionCookie ? { cookie: `keepsake_session=${sessionCookie}` } : {},
  });
  const text = await res.text();
  return { status: res.status, html: text, body: normalize(text) };
}

async function waitForReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // /history now redirects unauthenticated users. Use /api/session
      // (which 200s on env-fallback) as the readiness probe instead.
      const r = await fetch(`${BASE}/api/session`);
      if (r.status < 500) return;
    } catch {}
    await wait(500);
  }
  throw new Error(`dev server did not become ready at ${BASE}`);
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
function check(name, cond, detail = "") {
  if (cond) {
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    process.stdout.write(`  ✗ ${name}${detail ? `  (${detail})` : ""}\n`);
    failures.push(name);
  }
}

const nextBin = resolve(projectRoot, "node_modules/.bin/next");
const child = spawn(nextBin, ["dev", "--port", String(PORT)], {
  cwd: projectRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    BROWSER: "none",
    DEV_OWNER_ID: TEST_USER.id,
    DEV_OWNER_EMAIL: TEST_USER.email,
    DEV_OWNER_NAME: TEST_USER.name,
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
  process.stdout.write(`booting next dev on :${PORT}…\n`);
  await waitForReady();
  await mintSession();
  process.stdout.write(`server ready, running assertions:\n`);

  const { status, body } = await getHistory();

  // ── Wire ─────────────────────────────────────────────────────────────
  check("GET /history → 200", status === 200, `status=${status}`);
  check("response is a non-empty HTML string", typeof body === "string" && body.length > 0);

  // ── Page header + data-driven subtitle ───────────────────────────────
  check("contains activity timeline eyebrow", body.includes("Activity timeline"));
  check("contains header 'Account activity'", body.includes("Account activity"));
  check(
    "subtitle: 'Account/contact outreach history · 4 activities recorded'",
    body.includes("Account/contact outreach history · 4 activities recorded"),
  );

  // ── Month groups (mock data spans Mar / Feb / Jan 2026) ──────────────
  check("contains month group 'MARCH 2026'",    body.includes("MARCH 2026"));
  check("contains month group 'FEBRUARY 2026'", body.includes("FEBRUARY 2026"));
  check("contains month group 'JANUARY 2026'",  body.includes("JANUARY 2026"));

  // ── Per-activity rows (account/contact + outreach + channel badge text) ─
  check(
    "row: Ah Ma · Primary contact · Lunar New Year · Card",
    body.includes("Ah Ma")
      && body.includes("Primary contact: Ah Ma")
      && body.includes("Outreach: Lunar New Year")
      && body.includes("Card"),
  );
  check(
    "row: Lin account · Primary contact · Valentine's note · Email",
    body.includes("Lin")
      && body.includes("Primary contact: Lin")
      && body.includes("Outreach: Valentine's note")
      && body.includes("Partner account")
      && body.includes("Email"),
  );
  check(
    "row: Jun · Primary contact · Birthday · Email",
    body.includes("Jun")
      && body.includes("Primary contact: Jun")
      && body.includes("Outreach: Birthday")
      && body.includes("Email"),
  );
  check(
    "row: Priya · Primary contact · Deepavali · Card",
    body.includes("Priya")
      && body.includes("Primary contact: Priya")
      && body.includes("Outreach: Deepavali")
      && body.includes("Card"),
  );
  check("archived delivery rows keep account-like context", body.includes("Archived contact"));

  // ── Status labels ────────────────────────────────────────────────────
  check("contains status 'Delivered'", body.includes("Delivered"));
  check("contains status 'Opened'",    body.includes("Opened"));
  check("contains status 'Failed'",    body.includes("Failed"));

  // ── Each status row tags itself with a `data-delivery-status` attr ───
  check("renders data-delivery-status=\"delivered\"",
    body.includes('data-delivery-status="delivered"'));
  check("renders data-delivery-status=\"opened\"",
    body.includes('data-delivery-status="opened"'));
  check("renders data-delivery-status=\"failed\"",
    body.includes('data-delivery-status="failed"'));

  // ── Failed must NOT borrow the delivered/opened green-check ──────────
  // Slice the HTML around the `failed` row and verify it uses the warn
  // tone class + alert icon, never the green success markers used by
  // delivered/opened.
  const failedIndex = body.indexOf('data-delivery-status="failed"');
  const failedBlock = failedIndex >= 0
    ? body.slice(failedIndex, failedIndex + 1600)
    : null;
  check("failed status block is present in HTML",
    failedBlock !== null, "no failed status block found");
  if (failedBlock) {
    check("failed block carries ks-delivery-status--warn class",
      failedBlock.includes("ks-delivery-status--warn"));
    check("failed block does NOT carry ks-delivery-status--success class",
      !failedBlock.includes("ks-delivery-status--success"));
    check("failed block uses i-alert icon",
      failedBlock.includes("#i-alert"));
    check("failed block does NOT use i-check-plain icon",
      !failedBlock.includes("#i-check-plain"));
    check("failed block does NOT use the success green (#3F9E78)",
      !failedBlock.includes("#3F9E78"));
  }
} catch (err) {
  process.stdout.write(`harness error: ${err?.message ?? err}\n`);
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
  process.stdout.write(`\nall ok\n`);
  process.exit(0);
}
