import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = normalize(join(__dirname, ".."));
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function assert(condition, label, detail = "") {
  if (!condition) {
    throw new Error(`${label}${detail ? `: ${detail}` : ""}`);
  }
  process.stdout.write(`  ✓ ${label}\n`);
}

async function assertRejects(label, fn) {
  try {
    await fn();
  } catch {
    process.stdout.write(`  ✓ ${label}\n`);
    return;
  }

  throw new Error(`${label}: expected decrypt to fail`);
}

async function loadEnvelope() {
  const sourcePath = join(projectRoot, "lib/server/crypto/envelope.server.ts");
  const source = (await readFile(sourcePath, "utf8"))
    .replace(/^import "server-only";\n/, "");
  const output = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  const tempRoot = join(projectRoot, ".next", "test-crypto-envelope");
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, "run-"));
  const outputPath = join(tempDir, "envelope.server.cjs");
  await writeFile(outputPath, output);

  try {
    const require = createRequire(import.meta.url);
    const helper = require(outputPath);
    if (typeof helper.encrypt !== "function" || typeof helper.decrypt !== "function") {
      throw new Error("envelope.server.ts must export encrypt() and decrypt().");
    }
    return helper;
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

process.env.DEV_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString("base64");

const ownerA = "00000000-0000-4000-8000-000000000001";
const ownerB = "00000000-0000-4000-8000-000000000002";
const table = "people";
const column = "name_enc";
const plaintext = Buffer.from("Lin keeps the private thing private.", "utf8");

try {
  process.stdout.write("running crypto envelope checks:\n");

  const { encrypt, decrypt } = await loadEnvelope();
  const envelope = await encrypt(ownerA, table, column, plaintext);

  assert(
    envelope.length === NONCE_BYTES + plaintext.length + TAG_BYTES,
    "envelope is nonce(12) + ciphertext + tag(16)",
  );

  const roundtrip = await decrypt(ownerA, table, column, envelope);
  assert(Buffer.from(roundtrip).equals(plaintext), "roundtrip plaintext succeeds");

  const sameContext = await decrypt(ownerA, table, column, envelope);
  assert(Buffer.from(sameContext).equals(plaintext), "same owner/table/column decrypt succeeds");

  await assertRejects("different owner fails decrypt", () => decrypt(ownerB, table, column, envelope));
  await assertRejects("different table fails decrypt", () => decrypt(ownerA, "message_drafts", column, envelope));
  await assertRejects("different column fails decrypt", () => decrypt(ownerA, table, "since_enc", envelope));

  const tampered = Uint8Array.from(envelope);
  tampered[NONCE_BYTES] ^= 0xff;
  await assertRejects("tampered ciphertext fails decrypt", () => decrypt(ownerA, table, column, tampered));

  process.stdout.write("\nall crypto envelope checks passed\n");
} catch (error) {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
