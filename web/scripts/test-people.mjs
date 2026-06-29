// Smoke test for /api/people and /people. Boots `next dev` on an isolated
// port, runs contract assertions against the live HTTP surface, then checks
// the People page's ReMaster compatibility framing. No DB, no LLM — exercises
// the mock-backed payload to keep people, relationships, cultures, occasions,
// and account/contact rendering from silently drifting.
//
// Run via: pnpm test:people

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

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

async function getPeople(view = "active") {
  const suffix = view === "active" ? "" : `?view=${encodeURIComponent(view)}`;
  const res = await fetch(`${BASE}/api/people${suffix}`);
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

async function patchPeople(id, body) {
  const res = await fetch(`${BASE}/api/people/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const json = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body: json };
}

async function archivePeople(id) {
  const res = await fetch(`${BASE}/api/people/${encodeURIComponent(id)}/archive`, {
    method: "POST",
  });
  const json = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body: json };
}

async function restorePeople(id) {
  const res = await fetch(`${BASE}/api/people/${encodeURIComponent(id)}/restore`, {
    method: "POST",
  });
  const json = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body: json };
}

async function setNextFollowUp(id, date) {
  return postPersonAction(id, "follow-up", { nextFollowUpAt: date });
}

async function markFollowUpDone(id) {
  return postPersonAction(id, "follow-up/done");
}

async function snoozeFollowUp(id, date) {
  return postPersonAction(id, "follow-up/snooze", { nextFollowUpAt: date });
}

async function logTouchpoint(id, body) {
  return postPersonAction(id, "touchpoints", body);
}

async function postPersonAction(id, path, body) {
  const res = await fetch(`${BASE}/api/people/${encodeURIComponent(id)}/${path}`, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body: json };
}

async function getHomePage() {
  const res = await fetch(BASE, {
    headers: sessionCookie ? { cookie: `keepsake_session=${sessionCookie}` } : {},
  });
  const text = await res.text();
  return { status: res.status, body: normalize(text) };
}

async function getPeoplePage(path = "/people") {
  const res = await fetch(`${BASE}${path}`, {
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

async function runRhythmClassificationAssertions() {
  const tempDir = await mkdtemp(join(tmpdir(), "keepsake-remaster-rhythm-"));
  try {
    const source = await readFile(resolve(projectRoot, "lib/remaster/read-model.ts"), "utf8");
    const outputPath = join(tempDir, "read-model.cjs");
    await writeFile(outputPath, ts.transpileModule(source, {
      fileName: "read-model.ts",
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText);

    const require = createRequire(import.meta.url);
    const { classifyFollowUpRhythm } = require(outputPath);
    const todayISO = "2026-06-28";
    const cases = [
      ["overdue", { nextFollowUpAt: "2026-06-27" }],
      ["today", { nextFollowUpAt: "2026-06-28" }],
      ["this_week", { nextFollowUpAt: "2026-07-02" }],
      ["later", { nextFollowUpAt: "2026-07-20" }],
      ["unscheduled", {}],
    ];

    for (const [statusName, person] of cases) {
      const rhythm = classifyFollowUpRhythm(person, { todayISO });
      check(`rhythm classification includes ${statusName}`, rhythm.status === statusName, `got ${rhythm.status}`);
    }
  } finally {
    await rm(tempDir, { force: true, recursive: true });
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
  await runRhythmClassificationAssertions();
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

  const updatedKira = await patchPeople("p-kira", {
    name: "Kira Tan",
    segment: "prospect",
    organization: "Northstar Labs",
    roleTitle: "VP People Ops",
    sourceContext: "Post-event pilot follow-up",
    note: "Wants a short deck before July.",
    lastContactAt: "2026-06-20",
    nextFollowUpAt: "2026-07-08",
  });
  check("PATCH /api/people/[id] mock update → 200", updatedKira.status === 200, `status=${updatedKira.status}`);
  check("mock update returns new name", updatedKira.body?.name === "Kira Tan", `got ${updatedKira.body?.name}`);
  check("mock update returns nextFollowUpAt", updatedKira.body?.nextFollowUpAt === "2026-07-08", `got ${updatedKira.body?.nextFollowUpAt}`);
  check("mock update rewrites remember note", updatedKira.body?.knownFacts?.[0]?.text === "Wants a short deck before July.", `body=${JSON.stringify(updatedKira.body)}`);

  const setKiraFollowUp = await setNextFollowUp("p-kira", "2026-07-12");
  check("POST /api/people/[id]/follow-up mock → 200", setKiraFollowUp.status === 200, `status=${setKiraFollowUp.status}`);
  check("set follow-up returns nextFollowUpAt", setKiraFollowUp.body?.person?.nextFollowUpAt === "2026-07-12", `body=${JSON.stringify(setKiraFollowUp.body)}`);

  const snoozedKira = await snoozeFollowUp("p-kira", "2026-07-22");
  check("POST /api/people/[id]/follow-up/snooze mock → 200", snoozedKira.status === 200, `status=${snoozedKira.status}`);
  check("snooze returns moved nextFollowUpAt", snoozedKira.body?.person?.nextFollowUpAt === "2026-07-22", `body=${JSON.stringify(snoozedKira.body)}`);

  const loggedKira = await logTouchpoint("p-kira", { touchType: "meeting", occurredAt: "2026-06-22" });
  check("POST /api/people/[id]/touchpoints mock → 200", loggedKira.status === 200, `status=${loggedKira.status}`);
  check("log touchpoint returns lastContactAt", loggedKira.body?.person?.lastContactAt === "2026-06-22", `body=${JSON.stringify(loggedKira.body)}`);
  check("log touchpoint returns type", loggedKira.body?.person?.lastTouchpointType === "meeting", `body=${JSON.stringify(loggedKira.body)}`);

  const today = new Date().toISOString().slice(0, 10);
  const doneKira = await markFollowUpDone("p-kira");
  check("POST /api/people/[id]/follow-up/done mock → 200", doneKira.status === 200, `status=${doneKira.status}`);
  check("mark done clears nextFollowUpAt", !doneKira.body?.person?.nextFollowUpAt, `body=${JSON.stringify(doneKira.body)}`);
  check("mark done logs note touchpoint today", doneKira.body?.person?.lastContactAt === today && doneKira.body?.person?.lastTouchpointType === "note", `body=${JSON.stringify(doneKira.body)}`);

  const invalidPatch = await patchPeople("p-kira", { nextFollowUpAt: "2026-13-40" });
  check("PATCH /api/people/[id] invalid date → 400", invalidPatch.status === 400, `status=${invalidPatch.status}`);
  check("invalid patch code = invalid_request", invalidPatch.body?.code === "invalid_request", `body=${JSON.stringify(invalidPatch.body)}`);

  const missingPatch = await patchPeople("p-not-real", { name: "Missing" });
  check("PATCH /api/people/[id] missing person → 404", missingPatch.status === 404, `status=${missingPatch.status}`);
  check("missing person code = not_found", missingPatch.body?.code === "not_found", `body=${JSON.stringify(missingPatch.body)}`);

  await mintSession();
  const peoplePage = await getPeoplePage();
  const homePage = await getHomePage();
  const peopleClientSource = await readFile(resolve(projectRoot, "app/people/PeopleClient.tsx"), "utf8");
  const drawerSource = await readFile(resolve(projectRoot, "components/PersonDrawer.tsx"), "utf8");

  check("GET /people → 200", peoplePage.status === 200, `status=${peoplePage.status}`);
  check("GET / after maintenance update → 200", homePage.status === 200, `status=${homePage.status}`);
  check("People page renders business relationship title", peoplePage.body.includes("Business relationships"));
  check("People page renders Add contact CTA", peoplePage.body.includes("Add contact"));
  check(
    "People page renders business segment counts",
    peoplePage.body.includes("5 active contacts")
      && peoplePage.body.includes("archived view available")
      && peoplePage.body.includes("client, partner, prospect, investor, and personal segments"),
  );
  check(
    "People page renders active/archive management toggle",
    peoplePage.body.includes("Active") && peoplePage.body.includes("Archived"),
  );
  check(
    "People page renders business segment tabs",
    ["All", "Clients", "Partners", "Prospects", "Investors", "Personal"].every((label) => (
      peoplePage.body.includes(label)
    )),
  );
  check(
    "People page renders review queue filter",
    peoplePage.body.includes('data-testid="people-review-queue"')
      && peoplePage.body.includes("Needs attention")
      && peoplePage.body.includes("All active"),
  );
  check(
    "People page renders review queue dossier bridge",
    peoplePage.body.includes('data-testid="people-review-action"')
      && peoplePage.body.includes('data-action-target="dossier"')
      && peoplePage.body.includes("Open dossier"),
  );
  check(
    "People page reflects urgency ordering",
    peoplePage.body.indexOf('data-review-rank="1"') >= 0
      && peoplePage.body.indexOf("Mom", peoplePage.body.indexOf('data-review-rank="1"')) >= 0
      && peoplePage.body.indexOf("Mom", peoplePage.body.indexOf('data-review-rank="1"')) < peoplePage.body.indexOf("Kira Tan", peoplePage.body.indexOf('data-review-rank="1"')),
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
  check(
    "People page reflects updated contact identity",
    peoplePage.body.includes("Kira Tan") && peoplePage.body.includes("Northstar Labs / VP People Ops"),
  );
  check(
    "People page reflects updated follow-up cadence",
    peoplePage.body.includes("Next follow-up · Not scheduled")
      && peoplePage.body.includes("Unscheduled")
      && peoplePage.body.includes(`Last touch · Note · ${today}`),
  );
  check(
    "Home reflects updated relationship intelligence signal",
    homePage.body.includes("Kira Tan")
      && homePage.body.includes("No next follow-up set")
      && homePage.body.includes("Needs context")
      && homePage.body.includes("/people?review=p-kira"),
  );
  check(
    "People page keeps dossier drawer shell",
    peoplePage.body.includes('data-testid="person-dossier-drawer"'),
  );
  check(
    "People review item opens the dossier drawer",
    peopleClientSource.includes('data-testid="people-review-action"')
      && peopleClientSource.includes("onClick={() => setOpenId(account.primaryContactId)}"),
  );
  check(
    "People supports Home review query bridge with active guard",
    peopleClientSource.includes("useSearchParams")
      && peopleClientSource.includes("reviewPersonId")
      && peopleClientSource.includes("targetIsActive")
      && peopleClientSource.includes("setOpenId(reviewPersonId)"),
  );
  check(
    "People drawer source anchors business dossier sections",
    [
      "Relationship dossier",
      "OVERVIEW",
      "MAINTENANCE LOOP",
      'data-testid="person-maintenance-form"',
      "RELATIONSHIP CONTEXT",
      "TOUCHPOINTS",
      "Rhythm",
      "NOTES / REMEMBER",
      "FOLLOW-UP ACTIONS",
      'data-testid="person-follow-up-actions"',
      "drawer-action-bridge",
      "Review context, mark done, or draft outreach",
      "Mark done",
      "Draft outreach",
      "Set",
      "Snooze",
      "Log",
      "ACTIONS",
      "Save changes",
      "Archived dossier",
      "person-archived-state",
      "Restore contact",
      "Restore to edit",
      "Open workspace",
      "Draft next note",
      "Archive contact",
    ].every((label) => drawerSource.includes(label)),
  );

  const archivedKira = await archivePeople("p-kira");
  check("POST /api/people/[id]/archive mock → 200", archivedKira.status === 200, `status=${archivedKira.status}`);
  check("archive returns archivedAt", typeof archivedKira.body?.person?.archivedAt === "string", `body=${JSON.stringify(archivedKira.body)}`);

  const afterArchivePayload = await getPeople();
  check(
    "archived person leaves /api/people",
    !afterArchivePayload.body?.people?.some((person) => person.id === "p-kira"),
  );
  check("people.length becomes 4 after archive", afterArchivePayload.body?.people?.length === 4, `got ${afterArchivePayload.body?.people?.length}`);

  const archivedPayload = await getPeople("archived");
  const archivedKiraPayload = archivedPayload.body?.people?.find((person) => person.id === "p-kira");
  check("GET /api/people?view=archived → 200", archivedPayload.status === 200, `status=${archivedPayload.status}`);
  check("archived view includes archived Kira", archivedKiraPayload?.name === "Kira Tan", `body=${JSON.stringify(archivedPayload.body)}`);
  check("archived Kira keeps archivedAt", typeof archivedKiraPayload?.archivedAt === "string", `body=${JSON.stringify(archivedKiraPayload)}`);

  const archivedPeoplePage = await getPeoplePage();
  check("GET /people after archive → 200", archivedPeoplePage.status === 200, `status=${archivedPeoplePage.status}`);
  check("archived person leaves /people", !archivedPeoplePage.body.includes("Kira Tan"));
  const archivedBridgePage = await getPeoplePage("/people?review=p-kira");
  check(
    "archived person does not leak through review bridge",
    archivedBridgePage.status === 200 && !archivedBridgePage.body.includes("Kira Tan"),
    `status=${archivedBridgePage.status}`,
  );
  check(
    "People page active count drops after archive",
    archivedPeoplePage.body.includes("4 active contacts"),
  );

  const homeAfterArchive = await getHomePage();
  check("GET / after archive → 200", homeAfterArchive.status === 200, `status=${homeAfterArchive.status}`);
  check("Home excludes archived Kira", !homeAfterArchive.body.includes("Kira Tan"));

  const archivedSnooze = await snoozeFollowUp("p-kira", "2026-08-01");
  check("archived person follow-up action stays blocked", archivedSnooze.status === 404, `status=${archivedSnooze.status}`);
  const afterArchivedActionPayload = await getPeople();
  check(
    "archived follow-up action does not re-enter active payload",
    !afterArchivedActionPayload.body?.people?.some((person) => person.id === "p-kira"),
  );

  const restoredKira = await restorePeople("p-kira");
  check("POST /api/people/[id]/restore mock → 200", restoredKira.status === 200, `status=${restoredKira.status}`);
  check("restore returns active person", restoredKira.body?.person?.id === "p-kira" && !restoredKira.body?.person?.archivedAt);

  const afterRestorePayload = await getPeople();
  check(
    "restored person reappears in active /api/people",
    afterRestorePayload.body?.people?.some((person) => person.id === "p-kira"),
  );
  check("people.length returns to 5 after restore", afterRestorePayload.body?.people?.length === 5, `got ${afterRestorePayload.body?.people?.length}`);

  const archivedAfterRestore = await getPeople("archived");
  check(
    "restored person leaves archived view",
    !archivedAfterRestore.body?.people?.some((person) => person.id === "p-kira"),
  );

  const homeAfterRestore = await getHomePage();
  check("GET / after restore → 200", homeAfterRestore.status === 200, `status=${homeAfterRestore.status}`);
  check("restored Kira can re-enter Home follow-up copy", homeAfterRestore.body.includes("Kira Tan"));
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
