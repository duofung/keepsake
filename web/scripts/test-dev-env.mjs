// Checks scripts/check-dev-env.mjs without booting Next or Docker.
//
// Run via: pnpm test:dev-env

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const script = resolve(projectRoot, "scripts/check-dev-env.mjs");
const ENV_KEYS = [
  "DATABASE_URL",
  "DEV_ENCRYPTION_KEY_BASE64",
  "DEV_OWNER_EMAIL",
  "DEV_OWNER_ID",
  "DEV_OWNER_NAME",
  "KEEPSAKE_DATA_SOURCE",
];

const validAuth = {
  DEV_OWNER_ID: "55555555-5555-4555-8555-555555555555",
  DEV_OWNER_EMAIL: "dev-env@example.test",
  DEV_OWNER_NAME: "Dev Env",
};

const cases = [
  {
    name: "mock env passes",
    env: { ...validAuth },
    status: 0,
    includes: ["KEEPSAKE_DATA_SOURCE=mock"],
  },
  {
    name: "missing auth env fails",
    env: {},
    status: 1,
    includes: ["DEV_OWNER_ID is required", "Create `.env.local`"],
  },
  {
    name: "invalid source fails",
    env: { ...validAuth, KEEPSAKE_DATA_SOURCE: "sqlite" },
    status: 1,
    includes: ["KEEPSAKE_DATA_SOURCE must be either 'mock' or 'db'"],
  },
  {
    name: "db env missing db values fails",
    env: { ...validAuth, KEEPSAKE_DATA_SOURCE: "db" },
    status: 1,
    includes: ["DATABASE_URL is required", "DEV_ENCRYPTION_KEY_BASE64 is required"],
  },
  {
    name: "db env passes",
    env: {
      ...validAuth,
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/keepsake",
      DEV_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
      KEEPSAKE_DATA_SOURCE: "db",
    },
    status: 0,
    includes: ["KEEPSAKE_DATA_SOURCE=db"],
  },
];

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    process.stdout.write(`  ✗ ${name}${detail ? `  (${detail})` : ""}\n`);
    failures.push(name);
  }
}

function run(testCase) {
  const env = { ...process.env };
  for (const key of ENV_KEYS) {
    delete env[key];
  }

  const result = spawn(process.execPath, [script], {
    cwd: projectRoot,
    env: {
      ...env,
      ...testCase.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  result.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  result.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  return new Promise((resolve) => {
    result.on("close", (status) => {
      resolve({ status, output: `${stdout}\n${stderr}` });
    });
  });
}

process.stdout.write("running dev env guard checks:\n");

for (const testCase of cases) {
  const result = await run(testCase);
  check(`${testCase.name} exit ${testCase.status}`, result.status === testCase.status, `status=${result.status}`);

  for (const expected of testCase.includes) {
    check(
      `${testCase.name} output includes ${expected}`,
      result.output.includes(expected),
      result.output,
    );
  }
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall dev env guard checks passed\n");
}
