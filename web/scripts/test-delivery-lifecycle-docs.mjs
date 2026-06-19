// Anchor smoke for docs/DELIVERY_RUNBOOK.md.
//
// The runbook is the source of truth for "how do I exercise the
// delivery loop on my laptop". If a slice quietly drops one of the
// anchors below — the worker command, the webhook path, the secret
// env, a key troubleshooting symptom, or one of the documented
// non-goals — this smoke fails so we notice before merge.
//
// No Next, no Docker, no DB. Just a file read + substring assertions.
//
// Run via: pnpm test:delivery-runbook

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNBOOK_PATH = resolve(__dirname, "..", "docs", "DELIVERY_RUNBOOK.md");

const failures = [];
function check(name, cond, detail = "") {
  if (cond) process.stdout.write(`  ✓ ${name}\n`);
  else {
    process.stdout.write(`  ✗ ${name}${detail ? `  (${detail})` : ""}\n`);
    failures.push(name);
  }
}

let text;
try {
  text = await readFile(RUNBOOK_PATH, "utf8");
} catch (error) {
  process.stdout.write(`runbook not readable at ${RUNBOOK_PATH}: ${error?.message ?? error}\n`);
  process.exit(1);
}

process.stdout.write(`reading ${RUNBOOK_PATH}\n`);
process.stdout.write("running anchor assertions:\n");

// Sanity: the file isn't empty.
check("runbook is non-empty", text.length > 0,
  `length=${text.length}`);

// ── Lifecycle anchors ────────────────────────────────────────────────
check("documents `pnpm worker:run`", text.includes("pnpm worker:run"));
check("documents `POST /api/webhooks/deliveries`",
  text.includes("POST /api/webhooks/deliveries"));
check("documents `providerMessageId` as webhook identity",
  text.includes("providerMessageId"));

// ── Webhook events ───────────────────────────────────────────────────
check("documents `delivered` event", /\bdelivered\b/.test(text));
check("documents `opened` event",    /\bopened\b/.test(text));
check("documents `failed` event",    /\bfailed\b/.test(text));

// ── Required env ─────────────────────────────────────────────────────
check("documents `DELIVERY_WEBHOOK_SECRET`",
  text.includes("DELIVERY_WEBHOOK_SECRET"));
check("documents `KEEPSAKE_DATA_SOURCE=db`",
  text.includes("KEEPSAKE_DATA_SOURCE=db"));

// ── Troubleshooting anchors that must survive churn ──────────────────
check("troubleshoots `sender_not_connected`",
  text.includes("sender_not_connected"));
check("troubleshoots `sender_expired`",
  text.includes("sender_expired"));
check("troubleshoots stuck `sending` rows",
  text.includes("stuck in sending") || /\bsending\b/.test(text));
check("troubleshoots webhook 401 path",
  /401[^\n]*unauthorized/i.test(text));
check("troubleshoots webhook 404 path",
  /404[^\n]*delivery_not_found/i.test(text));
check("troubleshoots webhook 400 path",
  /400[^\n]*invalid_(?:json|event)/i.test(text));
check("troubleshoots webhook 501 path",
  /501[^\n]*not_configured/i.test(text));

// ── Explicit non-goals (these must NOT silently disappear) ───────────
check("declares: no Gmail push subscription yet",
  /no Gmail push subscription/i.test(text));
check("declares: no cron / daemon yet",
  /no cron/i.test(text));
check("declares: no live polling / SSE yet",
  /no live polling/i.test(text) || /no polling/i.test(text));

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall delivery-runbook anchor checks passed\n");
}
