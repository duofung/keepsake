// Checks scripts/init-dev-env.mjs in temporary directories.
//
// Run via: pnpm test:env-init

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const script = resolve(projectRoot, "scripts/init-dev-env.mjs");

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    process.stdout.write(`  ✗ ${name}${detail ? `  (${detail})` : ""}\n`);
    failures.push(name);
  }
}

async function withTempRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "keepsake-env-init-"));

  try {
    return await fn(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function run(root, args = []) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      KEEPSAKE_ENV_INIT_ROOT: root,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  return new Promise((resolve) => {
    child.on("close", (status) => {
      resolve({ status, output: `${stdout}\n${stderr}` });
    });
  });
}

process.stdout.write("running env init checks:\n");

await withTempRoot(async (root) => {
  const example = "DEV_OWNER_NAME=Init Fixture\nKEEPSAKE_DATA_SOURCE=mock\n";
  await writeFile(join(root, ".env.example"), example);

  const result = await run(root);
  const local = await readFile(join(root, ".env.local"), "utf8");

  check("creates .env.local", result.status === 0, result.output);
  check("copies .env.example contents", local === example, local);
  check("success output mentions .env.local", result.output.includes("Created .env.local"));
});

await withTempRoot(async (root) => {
  await writeFile(join(root, ".env.example"), "DEV_OWNER_NAME=Example\n");
  await writeFile(join(root, ".env.local"), "DEV_OWNER_NAME=Existing\n");

  const result = await run(root);
  const local = await readFile(join(root, ".env.local"), "utf8");

  check("refuses to overwrite existing .env.local", result.status === 1, result.output);
  check("keeps existing .env.local contents", local === "DEV_OWNER_NAME=Existing\n", local);
  check("refusal output mentions --force", result.output.includes("--force"));
});

await withTempRoot(async (root) => {
  await writeFile(join(root, ".env.example"), "DEV_OWNER_NAME=Forced\n");
  await writeFile(join(root, ".env.local"), "DEV_OWNER_NAME=Existing\n");

  const result = await run(root, ["--force"]);
  const local = await readFile(join(root, ".env.local"), "utf8");

  check("force overwrites existing .env.local", result.status === 0, result.output);
  check("force copies example contents", local === "DEV_OWNER_NAME=Forced\n", local);
  check("force output says reset", result.output.includes("Reset .env.local"));
});

await withTempRoot(async (root) => {
  const result = await run(root);

  check("missing .env.example fails", result.status === 1, result.output);
  check("missing example output is clear", result.output.includes(".env.example was not found"));
});

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall env init checks passed\n");
}
