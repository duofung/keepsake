// Lightweight architecture boundary checks. These do not boot Next.js.
//
// They guard the seams we want to preserve before the mock store is swapped
// for repositories:
// - only server mock seams may import lib/mock
// - every *.server.ts file under lib/server and lib/repositories starts with
//   import "server-only"
// - client components never import server runtime modules
// - the repository barrel stays type-only
//
// Run via: pnpm test:boundaries

import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = normalize(join(__dirname, ".."));

const CODE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const SCAN_DIRS = ["app", "components", "lib"];
const ALLOWED_MOCK_IMPORTERS = new Set([
  "lib/server/delivery-history/mock.server.ts",
  "lib/server/draft-context/mock.server.ts",
  "lib/server/people-payload/mock.server.ts",
]);

function toProjectPath(absPath) {
  return relative(projectRoot, absPath).split(sep).join("/");
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const absPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(absPath));
    } else if (CODE_EXTENSIONS.has(extname(entry.name))) {
      files.push(absPath);
    }
  }
  return files;
}

function importSpecifiers(source) {
  const specs = [];
  const staticImports = /\bimport\s+(?:type\s+)?(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicImports = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const regex of [staticImports, dynamicImports]) {
    for (const match of source.matchAll(regex)) specs.push(match[1]);
  }
  return specs;
}

function resolveSpecifier(fromProjectPath, specifier) {
  if (specifier.startsWith("@/")) return specifier.slice(2);
  if (specifier.startsWith(".")) {
    return normalize(join(dirname(fromProjectPath), specifier)).split(sep).join("/");
  }
  return specifier;
}

function isLibMockImport(fromProjectPath, specifier) {
  const resolved = resolveSpecifier(fromProjectPath, specifier);
  return resolved === "lib/mock" || resolved === "lib/mock.ts";
}

function isLibServerImport(fromProjectPath, specifier) {
  return resolveSpecifier(fromProjectPath, specifier).startsWith("lib/server/");
}

function isRepositoryServerImport(fromProjectPath, specifier) {
  const resolved = resolveSpecifier(fromProjectPath, specifier);
  return resolved.startsWith("lib/repositories/") && (
    resolved.endsWith(".server")
    || resolved.endsWith(".server.ts")
    || resolved.endsWith(".server.tsx")
    || resolved.includes(".server/")
  );
}

function isClientModule(source) {
  return source.trimStart().startsWith('"use client";')
    || source.trimStart().startsWith("'use client';");
}

function firstMeaningfulLine(source) {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
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

const files = (await Promise.all(
  SCAN_DIRS.map((dir) => walk(join(projectRoot, dir))),
)).flat();

const sourceByPath = new Map();
for (const absPath of files) {
  sourceByPath.set(toProjectPath(absPath), await readFile(absPath, "utf8"));
}

process.stdout.write("running architecture boundary checks:\n");

const mockImportViolations = [];
const clientServerImportViolations = [];
const missingServerOnly = [];

for (const [projectPath, source] of sourceByPath) {
  const specs = importSpecifiers(source);

  for (const spec of specs) {
    if (isLibMockImport(projectPath, spec) && !ALLOWED_MOCK_IMPORTERS.has(projectPath)) {
      mockImportViolations.push(`${projectPath} imports ${spec}`);
    }

    if (
      isClientModule(source)
      && (isLibServerImport(projectPath, spec) || isRepositoryServerImport(projectPath, spec))
    ) {
      clientServerImportViolations.push(`${projectPath} imports ${spec}`);
    }
  }

  if (
    (projectPath.startsWith("lib/server/") || projectPath.startsWith("lib/repositories/"))
    && projectPath.endsWith(".server.ts")
  ) {
    const firstLine = firstMeaningfulLine(source);
    if (firstLine !== 'import "server-only";' && firstLine !== "import 'server-only';") {
      missingServerOnly.push(`${projectPath} starts with ${JSON.stringify(firstLine)}`);
    }
  }
}

check(
  "lib/mock imports are confined to server mock seams",
  mockImportViolations.length === 0,
  mockImportViolations.join("; "),
);

check(
  'every server runtime *.server.ts starts with import "server-only"',
  missingServerOnly.length === 0,
  missingServerOnly.join("; "),
);

check(
  "client modules do not import server runtime modules",
  clientServerImportViolations.length === 0,
  clientServerImportViolations.join("; "),
);

const repoBarrel = sourceByPath.get("lib/repositories/index.ts") ?? "";
const runtimeRepoExports = repoBarrel
  .split(/\r?\n/)
  .map((line, index) => ({ line: line.trim(), number: index + 1 }))
  .filter(({ line }) => line.startsWith("export ") && !line.startsWith("export type "));

check(
  "repository barrel exports types only",
  runtimeRepoExports.length === 0,
  runtimeRepoExports.map(({ line, number }) => `line ${number}: ${line}`).join("; "),
);

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall ok\n");
}
