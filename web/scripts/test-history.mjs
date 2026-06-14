// Smoke test for the History page. Boots `next dev` on an isolated port,
// requests GET /history, and asserts the rendered HTML matches the mock
// delivery data. No DB, no LLM — just a regression net so that swapping the
// delivery-history seam later can't quietly break the History view.
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
  const res = await fetch(`${BASE}/history`);
  const text = await res.text();
  return { status: res.status, html: text, body: normalize(text) };
}

async function waitForReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/history`);
      if (r.ok) return;
    } catch {}
    await wait(500);
  }
  throw new Error(`dev server did not become ready at ${BASE}`);
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
  env: { ...process.env, BROWSER: "none", NEXT_TELEMETRY_DISABLED: "1" },
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
  process.stdout.write(`server ready, running assertions:\n`);

  const { status, body } = await getHistory();

  // ── Wire ─────────────────────────────────────────────────────────────
  check("GET /history → 200", status === 200, `status=${status}`);
  check("response is a non-empty HTML string", typeof body === "string" && body.length > 0);

  // ── Page header + data-driven subtitle ───────────────────────────────
  check("contains header 'History'", body.includes("History"));
  check(
    "subtitle: 'Everything you've sent · 4 keepsakes and counting'",
    body.includes("Everything you've sent · 4 keepsakes and counting"),
  );

  // ── Month groups (mock data spans Mar / Feb / Jan 2026) ──────────────
  check("contains month group 'MARCH 2026'",    body.includes("MARCH 2026"));
  check("contains month group 'FEBRUARY 2026'", body.includes("FEBRUARY 2026"));
  check("contains month group 'JANUARY 2026'",  body.includes("JANUARY 2026"));

  // ── Per-delivery rows (recipient + occasion + channel badge text) ────
  check(
    "row: Ah Ma · Lunar New Year · Card",
    body.includes("Ah Ma") && body.includes("Lunar New Year") && body.includes("Card"),
  );
  check(
    "row: Lin · Valentine's note · Email",
    body.includes("Lin") && body.includes("Valentine's note") && body.includes("Email"),
  );
  check(
    "row: Jun · Birthday · Email",
    body.includes("Jun") && body.includes("Birthday") && body.includes("Email"),
  );
  check(
    "row: Priya · Deepavali · Card",
    body.includes("Priya") && body.includes("Deepavali") && body.includes("Card"),
  );

  // ── Status labels ────────────────────────────────────────────────────
  check("contains status 'Delivered'", body.includes("Delivered"));
  check("contains status 'Opened'",    body.includes("Opened"));
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
