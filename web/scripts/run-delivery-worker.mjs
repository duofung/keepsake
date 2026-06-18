#!/usr/bin/env node
// Manual delivery-worker entry point.
//
// Runs the loop runtime once: an optional stuck-`sending` recovery pass
// followed by a bounded series of `processNextQueuedEmail()` ticks.
// Prints the JSON summary. Intended for local / staging operator use,
// not a daemon. Production scheduling lives outside this slice.
//
// Defaults match a conservative "operator runs this every few minutes":
//   maxTicks               = 50
//   recovery.staleAfterSeconds = 600   (10 minutes)
//   stopOnFailure          = false     (drain past per-delivery failures)
//
// Override via env so we don't have to maintain a flag parser:
//   KEEPSAKE_WORKER_MAX_TICKS=10
//   KEEPSAKE_WORKER_RECOVERY_AFTER=900     # seconds; 0 disables recovery
//   KEEPSAKE_WORKER_STOP_ON_FAILURE=1
//
// Usage:
//   KEEPSAKE_DATA_SOURCE=db \
//     DATABASE_URL=... \
//     KEEPSAKE_WORKER_DATABASE_URL=... \      # optional; defaults to DATABASE_URL
//     GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
//     pnpm worker:run

import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = normalize(join(__dirname, ".."));
const require = createRequire(import.meta.url);

async function loadWorker() {
  const tempRoot = join(projectRoot, ".next", "run-delivery-worker");
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, "run-"));
  const cleanup = () => rm(tempDir, { force: true, recursive: true });

  async function transpile(relPath, replacements = []) {
    const src = await readFile(join(projectRoot, relPath), "utf8");
    let cleaned = src.replace(/^import "server-only";\n/m, "");
    for (const [from, to] of replacements) cleaned = cleaned.replaceAll(from, to);
    const out = ts.transpileModule(cleaned, {
      fileName: relPath,
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const dest = join(tempDir, relPath.replace(/[\/\\]/g, "_").replace(/\.ts$/, ".cjs"));
    await writeFile(dest, out);
    return dest;
  }

  async function tr(relPath, aliases = {}) {
    const replacements = Object.entries(aliases).map(([alias, target]) => [
      `from "${alias}"`,
      `from "${target}"`,
    ]);
    return transpile(relPath, replacements);
  }

  // Order: dependencies first, then dependents.
  const envelope = await tr("lib/server/crypto/envelope.server.ts");
  const tx = await tr("lib/server/db/transaction.server.ts");
  const drafts = await tr("lib/repositories/drafts.server.ts", {
    "@/lib/server/db/transaction.server": tx,
    "@/lib/server/crypto/envelope.server": envelope,
  });
  const gmailAccts = await tr("lib/repositories/gmail-accounts.server.ts", {
    "@/lib/server/db/transaction.server": tx,
    "@/lib/server/crypto/envelope.server": envelope,
  });
  const deliveries = await tr("lib/repositories/deliveries.server.ts", {
    "@/lib/server/db/transaction.server": tx,
    "@/lib/server/crypto/envelope.server": envelope,
  });
  const transport = await tr(
    "lib/server/delivery-worker/gmail-transport.server.ts",
  );
  const dbWorker = await tr("lib/server/delivery-worker/db.server.ts", {
    "@/lib/server/db/transaction.server": tx,
    "@/lib/repositories/deliveries.server": deliveries,
    "@/lib/repositories/drafts.server": drafts,
    "@/lib/repositories/gmail-accounts.server": gmailAccts,
    "./gmail-transport.server": transport,
  });
  const runtime = await tr("lib/server/delivery-worker/runtime.server.ts");
  const mockWorker = await tr("lib/server/delivery-worker/mock.server.ts");
  const dispatcher = await tr("lib/server/delivery-worker/index.server.ts", {
    "./db.server": dbWorker,
    "./mock.server": mockWorker,
    "./runtime.server": runtime,
    "./gmail-transport.server": transport,
  });

  return {
    cleanup,
    runWorkerLoop: require(dispatcher).runWorkerLoop,
  };
}

function readNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number; got ${raw}.`);
  }
  return value;
}

function readBoolEnv(name) {
  const raw = process.env[name];
  if (raw === undefined) return false;
  return raw === "1" || raw === "true" || raw === "yes";
}

const maxTicks = Math.max(1, Math.floor(readNumberEnv("KEEPSAKE_WORKER_MAX_TICKS", 50)));
const recoverAfter = Math.max(0, Math.floor(readNumberEnv("KEEPSAKE_WORKER_RECOVERY_AFTER", 600)));
const stopOnFailure = readBoolEnv("KEEPSAKE_WORKER_STOP_ON_FAILURE");

const options = {
  maxTicks,
  stopOnFailure,
  ...(recoverAfter > 0
    ? { recovery: { staleAfterSeconds: recoverAfter } }
    : {}),
};

const { cleanup, runWorkerLoop } = await loadWorker();
try {
  const summary = await runWorkerLoop(options);
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  // Exit codes so operators / CI can branch:
  //   0 clean run (no per-delivery failures)
  //   2 the loop saw at least one per-delivery `failed`
  //   3 deployment-level misconfiguration (queue untouched)
  //   4 unexpected runtime crash inside the loop
  if (summary.stopReason === "misconfigured") process.exit(3);
  if (summary.stopReason === "fatal_error") process.exit(4);
  if (summary.failed > 0) process.exit(2);
  process.exit(0);
} catch (error) {
  process.stderr.write(
    `worker error: ${error?.message ?? String(error)}\n`,
  );
  process.exit(1);
} finally {
  await cleanup();
}
