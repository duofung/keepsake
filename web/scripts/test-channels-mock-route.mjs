// Smoke for POST /api/channels/mock — the P8-A command-channel
// contract. No Docker. Boots Next dev, no DB, no LLM. Covers:
//
//   * body validation (missing / malformed / empty text)
//   * relationship follow-up intent (中文 + English)
//   * compose request intent (中文 + English) — must return
//     `needs_review`, never `ok`
//   * unknown text → `unsupported`
//   * Response NEVER claims execution: it must not contain "sent",
//     "delivered", or "queued" — the channel layer never sends mail.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const PORT = Number(process.env.TEST_CHANNELS_PORT ?? 3220);
const BASE = `http://localhost:${PORT}`;
const nextBin = resolve(projectRoot, "node_modules/.bin/next");

const failures = [];
function check(name, cond, detail = "") {
  if (cond) process.stdout.write(`  ✓ ${name}\n`);
  else {
    process.stdout.write(`  ✗ ${name}${detail ? `  (${detail})` : ""}\n`);
    failures.push(name);
  }
}

async function waitForReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // POST to channels/mock with an empty body — we expect 400 < 500
      // so the readiness probe doesn't depend on /api/session env wiring.
      const r = await fetch(`${BASE}/api/channels/mock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (r.status < 500) return;
    } catch {}
    await wait(500);
  }
  throw new Error(`dev server did not become ready at ${BASE}`);
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((r) => child.once("exit", () => r(true))),
    wait(3_000).then(() => false),
  ]);
  if (!exited) child.kill("SIGKILL");
}

async function postChannel(body) {
  const res = await fetch(`${BASE}/api/channels/mock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, body: json };
}

const child = spawn(nextBin, ["dev", "--port", String(PORT)], {
  cwd: projectRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, BROWSER: "none", NEXT_TELEMETRY_DISABLED: "1" },
});
let serverError = "";
child.stderr.on("data", (b) => { serverError += b.toString(); });
child.stdout.on("data", () => {});

try {
  process.stdout.write(`booting next dev on :${PORT}…\n`);
  await waitForReady();
  process.stdout.write("server ready, running assertions:\n");

  // ── Body validation ───────────────────────────────────────────────
  {
    const res = await postChannel("{not json");
    check("malformed JSON → 400 invalid_request",
      res.status === 400 && res.body?.code === "invalid_request",
      `status=${res.status} code=${res.body?.code}`);
  }
  {
    const res = await postChannel({ provider: "mock" });
    check("missing text → 400 invalid_request",
      res.status === 400 && res.body?.code === "invalid_request"
        && res.body?.detail === "text is required",
      `status=${res.status} body=${JSON.stringify(res.body)}`);
  }
  {
    const res = await postChannel({ text: "   " });
    check("whitespace-only text → 400 invalid_request",
      res.status === 400 && res.body?.code === "invalid_request",
      `status=${res.status} code=${res.body?.code}`);
  }
  {
    const res = await postChannel({ provider: "whatsapp", text: "hi" });
    check("non-mock provider rejected → 400 invalid_request",
      res.status === 400 && res.body?.code === "invalid_request",
      `status=${res.status} body=${JSON.stringify(res.body)}`);
  }

  // ── relationship_followup_query (Chinese) ─────────────────────────
  {
    const res = await postChannel({ text: "最近有什么需要跟进的关系吗？" });
    check("中文 follow-up → 200", res.status === 200);
    check("中文 follow-up intent",
      res.body?.intent === "relationship_followup_query",
      `intent=${res.body?.intent}`);
    check("中文 follow-up status=ok",
      res.body?.status === "ok", `status=${res.body?.status}`);
    check("中文 follow-up suggestedAction.kind",
      res.body?.suggestedAction?.kind === "open_relationship_followups");
    check("中文 follow-up reply points to Keepsake",
      typeof res.body?.text === "string"
        && res.body.text.includes("Keepsake"));
  }

  // ── relationship_followup_query (English) ─────────────────────────
  {
    const res = await postChannel({
      text: "Anyone I should follow up with this week?",
    });
    check("EN follow-up intent",
      res.body?.intent === "relationship_followup_query",
      `intent=${res.body?.intent}`);
    check("EN follow-up status=ok",
      res.body?.status === "ok");
  }

  // ── compose_request (Chinese) ─────────────────────────────────────
  {
    const res = await postChannel({
      text: "帮我给 Helen 发一个邮件，她今天升职了，我要祝福她",
    });
    check("中文 compose → 200", res.status === 200);
    check("中文 compose intent",
      res.body?.intent === "compose_request",
      `intent=${res.body?.intent}`);
    check("中文 compose status=needs_review (NOT ok — channel never sends)",
      res.body?.status === "needs_review",
      `status=${res.body?.status}`);
    check("中文 compose suggestedAction.kind",
      res.body?.suggestedAction?.kind === "open_compose_workspace",
      `kind=${res.body?.suggestedAction?.kind}`);
    check("中文 compose suggestedAction.recipientHint = Helen",
      res.body?.suggestedAction?.recipientHint === "Helen",
      `recipientHint=${res.body?.suggestedAction?.recipientHint}`);
    check("中文 compose reply points to Keepsake review",
      res.body?.text?.includes("review") && res.body?.text?.includes("Keepsake"));
  }

  // ── compose_request (English) ─────────────────────────────────────
  {
    const res = await postChannel({
      text: "Send Helen an email — she got promoted today",
    });
    check("EN compose intent",
      res.body?.intent === "compose_request");
    check("EN compose status=needs_review",
      res.body?.status === "needs_review");
    check("EN compose suggestedAction.recipientHint = Helen",
      res.body?.suggestedAction?.recipientHint === "Helen");
  }

  // ── unknown / unsupported ─────────────────────────────────────────
  {
    const res = await postChannel({ text: "天气真好" });
    check("unknown text → 200", res.status === 200);
    check("unknown intent = unknown",
      res.body?.intent === "unknown");
    check("unknown status = unsupported",
      res.body?.status === "unsupported");
    check("unknown reply explains what we DO support",
      res.body?.text?.includes("follow-up")
        || res.body?.text?.includes("drafting"));
  }

  // ── Response never claims execution ────────────────────────────────
  // Pull the reply text from each intent and verify none of them
  // contain "sent", "delivered", or "queued" — the channel layer is
  // explicitly NOT the execution surface.
  const replyCases = [
    "最近有什么需要跟进的关系吗？",
    "帮我给 Helen 发一个邮件，她今天升职了",
    "Send Helen an email tomorrow",
    "天气真好",
  ];
  for (const text of replyCases) {
    const res = await postChannel({ text });
    const reply = (res.body?.text ?? "").toLowerCase();
    check(`reply for "${text.slice(0, 24)}…" does NOT claim execution`,
      !/\b(sent|delivered|queued)\b/.test(reply),
      `reply=${reply}`);
  }
} catch (error) {
  process.stdout.write(`harness error: ${error?.message ?? error}\n`);
  if (serverError) process.stdout.write(serverError);
  failures.push("harness");
} finally {
  await stopServer(child);
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall /api/channels/mock smoke checks passed\n");
}
