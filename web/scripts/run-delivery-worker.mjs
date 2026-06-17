#!/usr/bin/env node
// Manual one-shot delivery-worker entry point.
//
// Runs exactly one tick of `processNextQueuedEmail()` and prints the JSON
// result. Intended for local / staging operator use, not a daemon.
// Production scheduling lives outside this slice (the brief defers it).
//
// Usage:
//   pnpm db:seed:dev            # if you need a fixture
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

// Workers run outside `next dev`, so we transpile + import the seam
// directly. This mirrors how other repo / integration smokes load TS code
// (test-deliveries-repository.mjs, test-draft-autosave.mjs).

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

  // Resolve `@/lib/...` aliases by transpiling each module and rewriting
  // sibling imports to the transpiled file paths.
  const trMap = new Map();
  async function tr(relPath, aliases = {}) {
    const replacements = Object.entries(aliases).map(([alias, target]) => [
      `from "${alias}"`,
      `from "${target}"`,
    ]);
    const dest = await transpile(relPath, replacements);
    trMap.set(relPath, dest);
    return dest;
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

  return {
    cleanup,
    processNextQueuedEmailDb: require(dbWorker).processNextQueuedEmailDb,
  };
}

const { cleanup, processNextQueuedEmailDb } = await loadWorker();
try {
  const result = await processNextQueuedEmailDb();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  // Distinct exit codes so operators / CI can branch:
  //   0 sent / nothing_to_do
  //   2 per-delivery failure (operator investigates the one row)
  //   3 worker-level misconfiguration (no row was claimed; fix env)
  if (result.status === "failed") process.exit(2);
  if (result.status === "misconfigured") process.exit(3);
  process.exit(0);
} catch (error) {
  process.stderr.write(
    `worker error: ${error?.message ?? String(error)}\n`,
  );
  process.exit(1);
} finally {
  await cleanup();
}
