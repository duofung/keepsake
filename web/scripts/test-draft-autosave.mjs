// Controller-level test for `lib/workspace/draft-autosave.ts`.
//
// Two P4-B blockers this is the regression guard for:
//
//   Blocker 1 — pending edits MUST survive a failed PATCH. After a save
//     failure, the next `flush()` must re-attempt the same edits and a
//     send path must remain blocked until a save succeeds.
//
//   Blocker 2 — a PATCH response that arrives after the user has switched
//     to a different draft / version / person MUST NOT overwrite the
//     current compose UI.
//
// The controller has no React dependency, so this is a straight Node smoke
// against a transpiled copy of the TS file. No `next dev`, no HTTP, no
// Docker. Run via: pnpm test:draft-autosave

import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = normalize(join(__dirname, ".."));
const require = createRequire(import.meta.url);

const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    process.stdout.write(`  ✗ ${name}${detail ? `  (${detail})` : ""}\n`);
    failures.push(name);
  }
}

async function loadController() {
  const src = await readFile(
    join(projectRoot, "lib/workspace/draft-autosave.ts"),
    "utf8",
  );
  const compiled = ts.transpileModule(src, {
    fileName: "draft-autosave.ts",
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  const tempRoot = join(projectRoot, ".next", "test-draft-autosave");
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, "run-"));
  const out = join(tempDir, "draft-autosave.cjs");
  await writeFile(out, compiled);
  return {
    module: require(out),
    cleanup: () => rm(tempDir, { force: true, recursive: true }),
  };
}

function makeDraft(id, subject = "Hi", card = null, paragraphs = [{ text: "p" }]) {
  return {
    id,
    personId: "p1",
    occasionId: "o1",
    tone: "tender-intimate",
    toneLabel: "Tender",
    alternativeTones: [],
    subject,
    paragraphs,
    attachedCard: card,
    quickActions: [],
    assistantNote: "n",
  };
}

function makeRig({ debounceMs = 5 } = {}) {
  let activeKey = "kA";
  const calls = [];
  const statusLog = [];
  const applied = [];
  let nextResponse = null;

  function setNextResponse(payload) {
    nextResponse = payload;
  }

  const deps = {
    debounceMs,
    fetchPatch: async (body) => {
      const consumer = nextResponse;
      nextResponse = null;
      calls.push({ body, ts: calls.length });
      if (typeof consumer === "function") {
        return await consumer(body);
      }
      if (consumer === null) {
        // Default: succeed and echo back a new draft id.
        return {
          status: 200,
          draft: makeDraft(`v-${calls.length}`, body.subject, body.attachedCard, body.paragraphs),
        };
      }
      return consumer;
    },
    getActiveKey: () => activeKey,
    setStatus: (s) => statusLog.push(s),
    applyServerVersion: (d) => applied.push(d.id),
  };

  return {
    deps,
    calls,
    statusLog,
    applied,
    setNextResponse,
    setActiveKey: (key) => { activeKey = key; },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { module: mod, cleanup } = await loadController();
const { DraftAutosaveController } = mod;

try {
  // ── Phase 1: success path + no-op suppression ────────────────────────
  {
    process.stdout.write("phase 1 — happy path + no-op:\n");
    const rig = makeRig();
    const ctrl = new DraftAutosaveController(rig.deps);
    ctrl.setBaseline(makeDraft("base-1", "hello"), "kA");
    check("baseline starts idle", rig.statusLog.pop() === "idle");

    ctrl.schedule({ subject: "hello", paragraphs: [{ text: "p" }], attachedCard: null }, true);
    await wait(20);
    check("no-op did not fetch", rig.calls.length === 0, `calls=${rig.calls.length}`);
    check("no-op marked saved", rig.statusLog.includes("saved"));

    rig.statusLog.length = 0;
    ctrl.schedule({ subject: "edited", paragraphs: [{ text: "body edited" }], attachedCard: null }, true);
    await wait(20);
    check("real edit fired PATCH", rig.calls.length === 1);
    check("real body edit sent to PATCH", rig.calls[0]?.body.paragraphs?.[0]?.text === "body edited");
    check("real edit applied to UI", rig.applied.includes("v-1"));
    check("real edit ended in saved", rig.statusLog.at(-1) === "saved");
    check("real edit cleared pending", ctrl.__peekPending() === null);
    check("real edit advanced baseline id", ctrl.__peekBaseline()?.draftId === "v-1");
  }

  // ── Phase 2: BLOCKER 1 — failed save keeps pending dirty ─────────────
  {
    process.stdout.write("phase 2 — blocker 1 (failure does not clear pending):\n");
    const rig = makeRig();
    const ctrl = new DraftAutosaveController(rig.deps);
    ctrl.setBaseline(makeDraft("base-2", "hello"), "kA");

    rig.setNextResponse({ status: 500, draft: null });
    ctrl.schedule({ subject: "edit-fails", paragraphs: [{ text: "retry me" }], attachedCard: null }, true);
    await wait(20);
    check("first PATCH fired", rig.calls.length === 1);
    check("status reached error", rig.statusLog.at(-1) === "error");
    check("pending survived failure", ctrl.__peekPending() !== null,
      `pending=${JSON.stringify(ctrl.__peekPending())}`);
    check("baseline unchanged on failure", ctrl.__peekBaseline()?.draftId === "base-2");

    // User doesn't touch anything. They click Send → flush() runs again.
    // It must re-fire the SAME pending edits.
    rig.setNextResponse({ status: 500, draft: null });
    const secondFlushResult = await ctrl.flush();
    check("flush after failure returns false (send still blocked)",
      secondFlushResult === false, `got=${secondFlushResult}`);
    check("flush after failure re-fired the PATCH", rig.calls.length === 2);
    check("flush after failure sent the same pending edits",
      rig.calls[1].body.subject === "edit-fails"
      && rig.calls[1].body.paragraphs?.[0]?.text === "retry me");
    check("pending still survived second failure", ctrl.__peekPending() !== null);

    // Now the network recovers. The same flush should succeed and clear
    // pending so a subsequent send is no longer blocked.
    const thirdFlushResult = await ctrl.flush();
    check("flush after recovery returns true", thirdFlushResult === true);
    check("pending cleared on success", ctrl.__peekPending() === null);
    check("baseline advanced after recovery",
      ctrl.__peekBaseline()?.draftId !== "base-2");
  }

  // ── Phase 3: BLOCKER 2 — stale response does not overwrite UI ───────
  {
    process.stdout.write("phase 3 — blocker 2 (stale response does not overwrite UI):\n");
    const rig = makeRig();
    const ctrl = new DraftAutosaveController(rig.deps);
    ctrl.setBaseline(makeDraft("draftA", "subjA"), "kA");

    // Suspend the fetch so we can simulate navigation while it's in flight.
    let resolveInFlight;
    rig.setNextResponse((body) => new Promise((r) => {
      resolveInFlight = (payload) => r(payload);
      // remember what was sent
      lastSent = body;
    }));
    let lastSent = null;

    ctrl.schedule({ subject: "edit-on-A", paragraphs: [{ text: "body A" }], attachedCard: null }, true);
    await wait(5);
    check("PATCH for draftA is in flight",
      rig.calls.length === 1 && typeof resolveInFlight === "function");

    // User clicks a different version chip — setBaseline replaces the
    // edit target while the PATCH is still pending.
    const appliedBefore = [...rig.applied];
    ctrl.setBaseline(makeDraft("draftB", "subjB"), "kA");
    check("baseline switched to draftB",
      ctrl.__peekBaseline()?.draftId === "draftB");

    // Now resolve the stale PATCH successfully — the server saved a new
    // version derived from draftA. The controller must NOT push it into
    // the UI because the user has moved on.
    resolveInFlight({
      status: 200,
      draft: makeDraft("vA-stale", "edit-on-A", null, [{ text: "body A" }]),
    });
    await wait(20);
    check("stale response did NOT call applyServerVersion",
      rig.applied.length === appliedBefore.length,
      `applied=${JSON.stringify(rig.applied)}`);
    check("baseline still on draftB",
      ctrl.__peekBaseline()?.draftId === "draftB");

    // Also verify the same protection on a person/key switch.
    let resolveSecond;
    rig.setNextResponse(() => new Promise((r) => { resolveSecond = r; }));
    ctrl.schedule({ subject: "edit-on-B", paragraphs: [{ text: "body B" }], attachedCard: null }, true);
    await wait(5);
    rig.setActiveKey("kB");  // user navigated to a different person
    const appliedBeforeKeySwitch = [...rig.applied];
    resolveSecond({ status: 200, draft: makeDraft("vB-stale", "edit-on-B", null, [{ text: "body B" }]) });
    await wait(20);
    check("response after person-switch did NOT apply to UI",
      rig.applied.length === appliedBeforeKeySwitch.length);
  }

  // ── Phase 4: flush() awaits in-flight; new pending is sent after ──────
  {
    process.stdout.write("phase 4 — flush awaits in-flight then sends fresh pending:\n");
    const rig = makeRig();
    const ctrl = new DraftAutosaveController(rig.deps);
    ctrl.setBaseline(makeDraft("base-4", "hi"), "kA");

    let resolveFirst;
    rig.setNextResponse(() => new Promise((r) => { resolveFirst = r; }));
    ctrl.schedule({ subject: "edit-1", paragraphs: [{ text: "body 1" }], attachedCard: null }, true);
    await wait(5);

    // User keeps typing while PATCH is in flight.
    ctrl.schedule({ subject: "edit-2", paragraphs: [{ text: "body 2" }], attachedCard: null }, false);
    // Now click Send.
    const flushPromise = ctrl.flush();
    // Resolve first fetch successfully.
    resolveFirst({ status: 200, draft: makeDraft("v-after-1", "edit-1", null, [{ text: "body 1" }]) });
    const result = await flushPromise;
    check("flush eventually succeeds when both saves succeed", result === true);
    check("second PATCH was sent with newer edits",
      rig.calls.length === 2
      && rig.calls[1].body.subject === "edit-2"
      && rig.calls[1].body.paragraphs?.[0]?.text === "body 2");
    check("pending cleared once latest edits land",
      ctrl.__peekPending() === null);
  }
} finally {
  await cleanup();
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall draft-autosave controller checks passed\n");
  process.exit(0);
}
