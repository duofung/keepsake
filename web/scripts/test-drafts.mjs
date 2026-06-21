// Smoke test for /api/drafts. Boots `next dev` on an isolated port, runs
// 11 assertions against the live HTTP surface, then tears the server down.
// No DB, no LLM — just exercises the mock contract.
//
// Run via: pnpm test:drafts

import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const PORT = Number(process.env.TEST_PORT ?? 3131);
const BASE = `http://localhost:${PORT}`;

async function postDraft(body) {
  const res = await fetch(`${BASE}/api/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body: json };
}

async function patchDraft(body) {
  const res = await fetch(`${BASE}/api/drafts`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body: json };
}

async function getLatestDraft({ personId, occasionId }) {
  const query = new URLSearchParams({ personId });
  if (occasionId) query.set("occasionId", occasionId);

  const res = await fetch(`${BASE}/api/drafts?${query.toString()}`);
  const json = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body: json };
}

async function getDraftVersions({ personId, occasionId, limit }) {
  const query = new URLSearchParams({ personId });
  if (occasionId) query.set("occasionId", occasionId);
  if (limit !== undefined) query.set("limit", String(limit));

  const res = await fetch(`${BASE}/api/drafts/versions?${query.toString()}`);
  const json = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, body: json };
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

  // 0. Mock latest restore is a miss, so Workspace falls through to POST.
  {
    const { status } = await getLatestDraft({
      personId: "p-lin",
      occasionId: "occ-lin-anniv",
    });
    check("mock latest draft miss -> 204", status === 204, `status=${status}`);
  }

  {
    const { status, body } = await getDraftVersions({
      personId: "p-lin",
      occasionId: "occ-lin-anniv",
      limit: 5,
    });
    check("mock draft versions -> []", status === 200 && Array.isArray(body?.drafts) && body.drafts.length === 0, `status=${status}`);
  }

  // 1. Missing required fields → 400
  {
    const { status } = await postDraft({});
    check("missing fields → 400", status === 400, `status=${status}`);
  }

  // 2. Lin anniversary, no instruction → tender-intimate
  {
    const { status, body } = await postDraft({
      personId: "p-lin",
      occasionId: "occ-lin-anniv",
      userInstruction: "",
    });
    check("Lin initial → 200", status === 200, `status=${status}`);
    check(
      "Lin initial tone = tender-intimate",
      body?.tone === "tender-intimate",
      `tone=${body?.tone}`,
    );
    check(
      "Lin initial has paragraphs[]",
      Array.isArray(body?.paragraphs) && body.paragraphs.length > 0,
    );
  }

  // 3. Cross-person occasion id → 404
  {
    const { status } = await postDraft({
      personId: "p-lin",
      occasionId: "occ-aisha-raya",
      userInstruction: "",
    });
    check("cross-person occasion → 404", status === 404, `status=${status}`);
  }

  // 4. Lin "Make it more flirty" → playful
  {
    const { body } = await postDraft({
      personId: "p-lin",
      occasionId: "occ-lin-anniv",
      userInstruction: "Make it more flirty",
    });
    check(
      "Lin flirty → tone = playful",
      body?.tone === "playful",
      `tone=${body?.tone}`,
    );
  }

  // 5. Aisha Hari Raya → warm-festive AND no Christmas anywhere in the draft
  {
    const { body } = await postDraft({
      personId: "p-aisha",
      occasionId: "occ-aisha-raya",
      userInstruction: "",
    });
    check(
      "Aisha Hari Raya → tone = warm-festive",
      body?.tone === "warm-festive",
      `tone=${body?.tone}`,
    );
    const haystack = [
      body?.subject ?? "",
      ...(body?.paragraphs ?? []).map((p) => p.text),
      body?.assistantNote ?? "",
    ].join(" ");
    check(
      "Aisha draft contains no Christmas reference",
      !/christmas|x-?mas/i.test(haystack),
      `haystack=${haystack.slice(0, 80)}…`,
    );
    check(
      "Aisha draft uses a Hari Raya greeting",
      /selamat hari raya/i.test(haystack),
    );
  }

  // 6. PATCH /api/drafts — user-edit persistence.
  {
    // 6a. Shape failures → 400.
    {
      const { status } = await patchDraft({});
      check("PATCH missing fields -> 400", status === 400, `status=${status}`);
    }
    {
      const { status } = await patchDraft({
        draftId: "draft-anything",
        subject: 42,
        paragraphs: [{ text: "ok" }],
        attachedCard: null,
      });
      check("PATCH non-string subject -> 400", status === 400, `status=${status}`);
    }
    {
      const { status } = await patchDraft({
        draftId: "draft-anything",
        subject: "ok",
        paragraphs: [{ nope: "missing text" }],
        attachedCard: null,
      });
      check("PATCH malformed paragraphs -> 400", status === 400, `status=${status}`);
    }
    {
      const { status } = await patchDraft({
        draftId: "draft-anything",
        subject: "ok",
        paragraphs: [{ text: "ok" }],
        attachedCard: { styleLabel: "x" /* missing the rest */ },
      });
      check("PATCH malformed attachedCard -> 400", status === 400, `status=${status}`);
    }

    // 6b. Unknown draftId (mock store doesn't know this id) -> 404.
    {
      const { status, body } = await patchDraft({
        draftId: "draft-does-not-exist-zzz",
        subject: "Updated subject",
        paragraphs: [{ text: "Updated body" }],
        attachedCard: null,
      });
      check("PATCH unknown draftId -> 404", status === 404, `status=${status}`);
      check("PATCH unknown error is generic", body?.error === "Draft not found");
    }

    // 6c. Seed a fresh draft to edit.
    const { body: base } = await postDraft({
      personId: "p-kira",
      occasionId: null,
      userInstruction: "",
    });
    check("seed Kira base draft -> 200", typeof base?.id === "string" && base.id.length > 0);
    const baseId = base.id;
    const baseSubject = base.subject;
    const baseParagraphs = base.paragraphs;
    const baseCard = base.attachedCard;

    // 6d. No-op PATCH (same subject + same card) returns base — no new version.
    {
      const { status, body } = await patchDraft({
        draftId: baseId,
        subject: baseSubject,
        paragraphs: baseParagraphs,
        attachedCard: baseCard,
      });
      check("PATCH no-op -> 200", status === 200);
      check("PATCH no-op returns base id", body?.id === baseId);
    }

    // 6e. PATCH new subject creates a new canonical version and exposes it
    //     to latest / versions reads.
    const editedSubject = `${baseSubject} (edited)`;
    let editedId;
    {
      const { status, body } = await patchDraft({
        draftId: baseId,
        subject: editedSubject,
        paragraphs: baseParagraphs,
        attachedCard: baseCard,
      });
      check("PATCH new subject -> 200", status === 200);
      check("PATCH new subject changes id", body?.id && body.id !== baseId);
      check("PATCH new subject sets subject", body?.subject === editedSubject);
      check("PATCH new subject preserves paragraphs",
        Array.isArray(body?.paragraphs) && body.paragraphs.length === base.paragraphs.length);
      check("PATCH new subject preserves tone", body?.tone === base.tone);
      check("PATCH new subject preserves quickActions",
        Array.isArray(body?.quickActions) && body.quickActions.length === base.quickActions.length);
      editedId = body?.id;
    }

    // 6e2. PATCH edited body creates a new canonical version too.
    const editedParagraphs = [
      { text: "I changed the email body directly in Workspace." },
      { text: "This should be saved before delivery queueing." },
    ];
    {
      const { status, body } = await patchDraft({
        draftId: editedId,
        subject: editedSubject,
        paragraphs: editedParagraphs,
        attachedCard: baseCard,
      });
      check("PATCH edited body -> 200", status === 200);
      check("PATCH edited body changes id", body?.id && body.id !== editedId);
      check("PATCH edited body persists paragraphs",
        body?.paragraphs?.[0]?.text === editedParagraphs[0].text
        && body?.paragraphs?.[1]?.text === editedParagraphs[1].text);
      editedId = body?.id;
    }

    // 6f. Mock latest read reflects the edited version.
    {
      const { status, body } = await getLatestDraft({ personId: "p-kira" });
      check("mock latest after edit -> 200", status === 200, `status=${status}`);
      check("mock latest reflects edited id", body?.id === editedId);
      check("mock latest reflects edited subject", body?.subject === editedSubject);
    }

    // 6g. Mock versions read includes both base and edited (newest first).
    {
      const { status, body } = await getDraftVersions({
        personId: "p-kira",
        limit: 5,
      });
      check("mock versions after edit -> 200", status === 200);
      const ids = (body?.drafts ?? []).map((d) => d.id);
      check("mock versions includes edited", ids.includes(editedId));
      check("mock versions includes base", ids.includes(baseId));
      check("mock versions newest first (edited before base)",
        ids.indexOf(editedId) < ids.indexOf(baseId));
    }

    // 6h. PATCH null attachedCard → card is null on the saved draft.
    if (baseCard) {
      const { status, body } = await patchDraft({
        draftId: editedId,
        subject: editedSubject,
        paragraphs: editedParagraphs,
        attachedCard: null,
      });
      check("PATCH null attachedCard -> 200", status === 200);
      check("PATCH null attachedCard removes card", body?.attachedCard === null);
    }

    // 6i. PATCH preserves the same MessageDraft shape — Workspace's
    //     version chip rendering depends on tone/toneLabel/quickActions
    //     being present even on edited rows. Provenance fields like
    //     userInstruction / modelProvider are not exposed on the public
    //     domain shape; the DB route smoke covers their persistence.
    {
      const { body } = await patchDraft({
        draftId: baseId,
        subject: `${baseSubject} (shape check)`,
        paragraphs: baseParagraphs,
        attachedCard: baseCard,
      });
      check("PATCH preserves toneLabel", typeof body?.toneLabel === "string" && body.toneLabel.length > 0);
      check("PATCH preserves quickActions shape",
        Array.isArray(body?.quickActions) && body.quickActions.every((q) => (
          typeof q?.label === "string" && typeof q?.prompt === "string" && typeof q?.iconHint === "string"
        )));
    }
  }
} catch (err) {
  process.stdout.write(`harness error: ${err?.message ?? err}\n`);
  failures.push("harness");
} finally {
  child.kill("SIGTERM");
  // Give next a moment to shut down cleanly.
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
