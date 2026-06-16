// Unit checks for lib/server/auth/current-user.server.ts.
// This does not boot Next.js, Postgres, Docker, or any route handler.
//
// Run via: pnpm test:auth

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = normalize(join(__dirname, ".."));
const AUTH_ENV_KEYS = [
  "DEV_OWNER_ID",
  "DEV_OWNER_EMAIL",
  "DEV_OWNER_NAME",
  "KEEPSAKE_DATA_SOURCE",
];

const validOwnerId = "11111111-1111-4111-8111-111111111111";
const validEmail = "ada.lovelace@example.test";
const validName = "Ada Lovelace";

function assert(condition, label, detail = "") {
  if (!condition) {
    throw new Error(`${label}${detail ? `: ${detail}` : ""}`);
  }
  process.stdout.write(`  ✓ ${label}\n`);
}

async function withAuthEnv(values, fn) {
  const previous = new Map(AUTH_ENV_KEYS.map((key) => [key, process.env[key]]));

  try {
    for (const key of AUTH_ENV_KEYS) {
      delete process.env[key];
    }

    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }

    return await fn();
  } finally {
    for (const key of AUTH_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function loadCurrentUserModule() {
  const sourcePath = join(projectRoot, "lib/server/auth/current-user.server.ts");
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

  const tempRoot = join(projectRoot, ".next", "test-auth-current-user");
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, "run-"));
  const outputPath = join(tempDir, "current-user.server.cjs");
  await writeFile(outputPath, output);

  try {
    const require = createRequire(import.meta.url);
    return require(outputPath);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

async function assertAuthError(label, fn, expectedKind, AuthError) {
  try {
    await fn();
  } catch (error) {
    assert(error instanceof AuthError, `${label} throws AuthError`);
    assert(
      error.kind === expectedKind,
      `${label} kind = ${expectedKind}`,
      `kind=${error.kind}`,
    );
    return;
  }

  throw new Error(`${label}: expected AuthError`);
}

try {
  process.stdout.write("running current-user auth checks:\n");

  const {
    AuthError,
    currentUserIdOrThrow,
    currentUserOrThrow,
  } = await loadCurrentUserModule();

  await withAuthEnv({
    DEV_OWNER_ID: validOwnerId,
    DEV_OWNER_EMAIL: validEmail,
    DEV_OWNER_NAME: validName,
  }, async () => {
    const user = await currentUserOrThrow();
    assert(user.id === validOwnerId, "valid env returns user.id");
    assert(user.email === validEmail, "valid env returns user.email");
    assert(user.name === validName, "valid env returns user.name");
    assert(user.initials === "AL", "valid env derives initials");
    assert(user.sendingAccount === null, "valid env returns null sendingAccount");
    assert(currentUserIdOrThrow() === validOwnerId, "currentUserIdOrThrow returns OwnerId");
  });

  await withAuthEnv({
    DEV_OWNER_EMAIL: validEmail,
    DEV_OWNER_NAME: validName,
  }, async () => {
    await assertAuthError(
      "missing DEV_OWNER_ID",
      () => currentUserOrThrow(),
      "unauthenticated",
      AuthError,
    );
  });

  await withAuthEnv({
    DEV_OWNER_ID: "not-a-uuid",
    DEV_OWNER_EMAIL: validEmail,
    DEV_OWNER_NAME: validName,
  }, async () => {
    await assertAuthError(
      "invalid DEV_OWNER_ID",
      () => currentUserOrThrow(),
      "misconfigured",
      AuthError,
    );
  });

  await withAuthEnv({
    DEV_OWNER_ID: validOwnerId,
    DEV_OWNER_EMAIL: "not-an-email",
    DEV_OWNER_NAME: validName,
  }, async () => {
    await assertAuthError(
      "invalid DEV_OWNER_EMAIL",
      () => currentUserOrThrow(),
      "misconfigured",
      AuthError,
    );
  });

  await withAuthEnv({
    DEV_OWNER_ID: validOwnerId,
    DEV_OWNER_EMAIL: validEmail,
    DEV_OWNER_NAME: "   ",
  }, async () => {
    await assertAuthError(
      "invalid DEV_OWNER_NAME",
      () => currentUserOrThrow(),
      "misconfigured",
      AuthError,
    );
  });

  process.stdout.write("\nall current-user auth checks passed\n");
} catch (error) {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
