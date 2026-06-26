// Smoke test for /api/people and /people. Boots `next dev` on an isolated
// port, runs contract assertions against the live HTTP surface, then checks
// the People page's ReMaster compatibility framing. No DB, no LLM — exercises
// the mock-backed payload to keep people, relationships, cultures, occasions,
// and account/contact rendering from silently drifting.
//
// Run via: pnpm test:people

import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const PORT = Number(process.env.TEST_PORT ?? 3132);
const BASE = `http://localhost:${PORT}`;
const SESSION_SECRET = "test-people-app-session-secret-min-32-chars-ok";

const testUser = {
  id: "55555555-5555-4555-8555-555555555555",
  email: "people-fixture@example.test",
  name: "People Fixture",
};

let sessionCookie = "";

function normalize(html) {
  return html
    .replace(/<!--\s*-->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&amp;/g, "&");
}

async function getPeople() {
  const res = await fetch(`${BASE}/api/people`);
  const json = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body: json };
}

async function postPeople(body) {
  const res = await fetch(`${BASE}/api/people`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body: json };
}

async function getPeoplePage() {
  const res = await fetch(`${BASE}/people`, {
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

async function waitForReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/people`);
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
  process.stdout.write(`booting next dev on :${PORT}…\n`);
  await waitForReady();
  process.stdout.write(`server ready, running assertions:\n`);

  const { status, body } = await getPeople();

  check("GET /api/people → 200", status === 200, `status=${status}`);
  check("response is a JSON object", body && typeof body === "object");

  // ── Shape: arrays present and correctly sized ─────────────────────────
  const people = body?.people ?? [];
  const relationships = body?.relationships ?? [];
  const cultures = body?.cultures ?? [];
  const occasions = body?.occasions ?? [];

  check("people.length = 5",        people.length === 5,        `got ${people.length}`);
  check("relationships.length = 5", relationships.length === 5, `got ${relationships.length}`);
  check("cultures.length = 4",      cultures.length === 4,      `got ${cultures.length}`);
  check("occasions.length = 7",     occasions.length === 7,     `got ${occasions.length}`);

  // ── Aisha + malay-muslim culture wiring ───────────────────────────────
  const aisha = people.find((p) => p.id === "p-aisha");
  check("Aisha present in payload", !!aisha);
  check(
    "Aisha cultureId = malay-muslim",
    aisha?.cultureId === "malay-muslim",
    `got ${aisha?.cultureId}`,
  );

  const malayMuslim = cultures.find((c) => c.id === "malay-muslim");
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

  // ── Lin's primary occasion ────────────────────────────────────────────
  const lin = people.find((p) => p.id === "p-lin");
  check("Lin present in payload", !!lin);
  check("Lin segment = client", lin?.segment === "client", `got ${lin?.segment}`);
  check("Lin organization = Lattice Works", lin?.organization === "Lattice Works", `got ${lin?.organization}`);
  check(
    "Lin nextOccasionId = occ-lin-anniv",
    lin?.nextOccasionId === "occ-lin-anniv",
    `got ${lin?.nextOccasionId}`,
  );

  const linAnniv = occasions.find((o) => o.id === "occ-lin-anniv");
  check("occ-lin-anniv present in occasions", !!linAnniv);
  check(
    "occ-lin-anniv.personId = p-lin",
    linAnniv?.personId === "p-lin",
    `got ${linAnniv?.personId}`,
  );

  const created = await postPeople({
    name: "Helen Zhang",
    segment: "client",
    organization: "Northstar Labs",
    roleTitle: "Head of Partnerships",
    sourceContext: "Warm intro from Malaysia launch",
    note: "Prefers concise next-step emails.",
    starred: true,
  });
  check("POST /api/people mock create → 201", created.status === 201, `status=${created.status}`);
  check("mock created person has local id", /^local-/.test(created.body?.id ?? ""), `id=${created.body?.id}`);
  check("mock created segment preserved", created.body?.segment === "client", `got ${created.body?.segment}`);
  check("mock created organization preserved", created.body?.organization === "Northstar Labs", `got ${created.body?.organization}`);

  await mintSession();
  const peoplePage = await getPeoplePage();

  check("GET /people → 200", peoplePage.status === 200, `status=${peoplePage.status}`);
  check("People page renders business relationship title", peoplePage.body.includes("Business relationships"));
  check("People page renders Add contact CTA", peoplePage.body.includes("Add contact"));
  check(
    "People page renders business segment counts",
    peoplePage.body.includes("5 contacts across client, partner, prospect, investor, and personal segments"),
  );
  check(
    "People page renders business segment tabs",
    ["All", "Clients", "Partners", "Prospects", "Investors", "Personal"].every((label) => (
      peoplePage.body.includes(label)
    )),
  );
  check(
    "People page renders business sections",
    peoplePage.body.includes("CLIENTS")
      && peoplePage.body.includes("PARTNERS")
      && peoplePage.body.includes("PROSPECTS")
      && peoplePage.body.includes("INVESTORS")
      && peoplePage.body.includes("PERSONAL"),
  );
  check(
    "People page renders next follow-up from compatibility model",
    peoplePage.body.includes("Next follow-up · Anniversary · in 12 days"),
  );
  check(
    "People page renders last touch from compatibility model",
    peoplePage.body.includes("Last touch · Opened · 2026-02-14"),
  );
  check(
    "People page renders organization and role",
    peoplePage.body.includes("Lattice Works / Founder"),
  );
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
