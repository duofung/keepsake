// Unit checks for `lib/server/auth/current-user.server.ts` + the new
// session cookie helper. Stubs `next/headers` so we can drive the
// cookie path without booting Next.
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
  "APP_SESSION_SIGNING_SECRET",
];

const validOwnerId = "11111111-1111-4111-8111-111111111111";
const validEmail = "ada.lovelace@example.test";
const validName = "Ada Lovelace";
const validSecret = "this-is-at-least-thirty-two-chars-long-abc";

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

async function loadAuthModules() {
  const tempRoot = join(projectRoot, ".next", "test-auth-current-user");
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, "run-"));

  // Stub for `next/headers` cookies(). The current-user module reads
  // the keepsake_session cookie via this surface.
  const cookieStubPath = join(tempDir, "next-headers-stub.cjs");
  await writeFile(
    cookieStubPath,
    `
let nextCookieValue = null;
module.exports = {
  cookies: async () => ({
    get: (name) => {
      if (name === "keepsake_session" && nextCookieValue !== null) {
        return { value: nextCookieValue };
      }
      return undefined;
    },
  }),
  __setSessionCookieForTest: (value) => { nextCookieValue = value; },
  __clearSessionCookieForTest: () => { nextCookieValue = null; },
};
`,
  );

  async function transpile(relPath, replacements = {}) {
    const sourcePath = join(projectRoot, relPath);
    let source = (await readFile(sourcePath, "utf8")).replace(
      /^import "server-only";\n/,
      "",
    );
    for (const [from, to] of Object.entries(replacements)) {
      source = source.replaceAll(`from "${from}"`, `from "${to}"`);
    }
    const output = ts.transpileModule(source, {
      fileName: sourcePath,
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const dest = join(
      tempDir,
      relPath.replace(/[\/\\]/g, "_").replace(/\.ts$/, ".cjs"),
    );
    await writeFile(dest, output);
    return dest;
  }

  const sessionPath = await transpile("lib/server/auth/session.server.ts");
  const currentUserPath = await transpile(
    "lib/server/auth/current-user.server.ts",
    {
      "next/headers": cookieStubPath,
      "./session.server": sessionPath,
    },
  );

  const require = createRequire(import.meta.url);
  return {
    session: require(sessionPath),
    currentUser: require(currentUserPath),
    cookieStub: require(cookieStubPath),
    cleanup: () => rm(tempDir, { force: true, recursive: true }),
  };
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

let cleanup = async () => {};
try {
  process.stdout.write("running current-user auth checks:\n");

  const { session, currentUser, cookieStub, cleanup: cleanupAuth } =
    await loadAuthModules();
  cleanup = cleanupAuth;

  const {
    AuthError,
    currentUserIdOrThrow,
    currentUserOrThrow,
  } = currentUser;
  const {
    SessionError,
    issueSessionCookie,
    verifySessionCookie,
    SESSION_COOKIE_NAME,
  } = session;

  // ── DEV_OWNER env fallback (no cookie) ─────────────────────────────
  process.stdout.write("phase 1 — DEV_OWNER env fallback when no cookie:\n");
  await withAuthEnv({
    DEV_OWNER_ID: validOwnerId,
    DEV_OWNER_EMAIL: validEmail,
    DEV_OWNER_NAME: validName,
  }, async () => {
    cookieStub.__clearSessionCookieForTest();
    const user = await currentUserOrThrow();
    assert(user.id === validOwnerId, "env-fallback returns user.id");
    assert(user.email === validEmail, "env-fallback returns user.email");
    assert(user.name === validName, "env-fallback returns user.name");
    assert(user.initials === "AL", "env-fallback derives initials");
    assert(user.sendingAccount === null, "env-fallback returns null sendingAccount");
    assert((await currentUserIdOrThrow()) === validOwnerId,
      "currentUserIdOrThrow returns OwnerId (async)");
  });

  // ── DEV_OWNER env errors (no cookie) ───────────────────────────────
  process.stdout.write("phase 2 — DEV_OWNER env error mapping:\n");
  await withAuthEnv({
    DEV_OWNER_EMAIL: validEmail,
    DEV_OWNER_NAME: validName,
  }, async () => {
    cookieStub.__clearSessionCookieForTest();
    await assertAuthError("missing DEV_OWNER_ID",
      () => currentUserOrThrow(), "unauthenticated", AuthError);
  });
  await withAuthEnv({
    DEV_OWNER_ID: "not-a-uuid",
    DEV_OWNER_EMAIL: validEmail,
    DEV_OWNER_NAME: validName,
  }, async () => {
    cookieStub.__clearSessionCookieForTest();
    await assertAuthError("invalid DEV_OWNER_ID",
      () => currentUserOrThrow(), "misconfigured", AuthError);
  });
  await withAuthEnv({
    DEV_OWNER_ID: validOwnerId,
    DEV_OWNER_EMAIL: "not-an-email",
    DEV_OWNER_NAME: validName,
  }, async () => {
    cookieStub.__clearSessionCookieForTest();
    await assertAuthError("invalid DEV_OWNER_EMAIL",
      () => currentUserOrThrow(), "misconfigured", AuthError);
  });
  await withAuthEnv({
    DEV_OWNER_ID: validOwnerId,
    DEV_OWNER_EMAIL: validEmail,
    DEV_OWNER_NAME: "   ",
  }, async () => {
    cookieStub.__clearSessionCookieForTest();
    await assertAuthError("invalid DEV_OWNER_NAME",
      () => currentUserOrThrow(), "misconfigured", AuthError);
  });

  // ── Session helper: encode/decode roundtrip ────────────────────────
  process.stdout.write("phase 3 — session helper roundtrip:\n");
  await withAuthEnv({
    APP_SESSION_SIGNING_SECRET: validSecret,
  }, async () => {
    const cookie = issueSessionCookie({
      ownerId: validOwnerId,
      email: validEmail,
      name: validName,
      nowMs: 1_700_000_000_000,
      ttlSeconds: 3600,
    });
    assert(cookie.name === SESSION_COOKIE_NAME,
      "issueSessionCookie returns the canonical cookie name");
    assert(typeof cookie.value === "string" && cookie.value.includes("."),
      "cookie value is payload.sig");
    assert(cookie.options.httpOnly === true, "cookie HttpOnly");
    assert(cookie.options.sameSite === "lax", "cookie SameSite=Lax");
    assert(cookie.options.maxAge === 3600,
      "cookie maxAge matches ttlSeconds", `maxAge=${cookie.options.maxAge}`);

    const decoded = verifySessionCookie({
      cookieValue: cookie.value,
      nowMs: 1_700_000_000_500,
    });
    assert(decoded.ownerId === validOwnerId, "decoded ownerId");
    assert(decoded.email === validEmail, "decoded email");
    assert(decoded.name === validName, "decoded name");
    assert(decoded.expiresAt === 1_700_000_000_000 + 3600 * 1000,
      "decoded expiresAt matches");
  });

  // ── Session helper: failure modes ──────────────────────────────────
  process.stdout.write("phase 4 — session helper failure modes:\n");
  await withAuthEnv({
    APP_SESSION_SIGNING_SECRET: validSecret,
  }, async () => {
    const fresh = issueSessionCookie({
      ownerId: validOwnerId, email: validEmail, name: validName,
      nowMs: 1_700_000_000_000, ttlSeconds: 3600,
    });
    // tampered signature
    let threw = null;
    try {
      verifySessionCookie({
        cookieValue: `${fresh.value.split(".")[0]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
        nowMs: 1_700_000_000_500,
      });
    } catch (e) { threw = e; }
    assert(threw instanceof SessionError && threw.kind === "unauthenticated",
      "tampered signature throws unauthenticated");

    // malformed
    threw = null;
    try { verifySessionCookie({ cookieValue: "no-dot-here" }); }
    catch (e) { threw = e; }
    assert(threw instanceof SessionError && threw.kind === "unauthenticated",
      "malformed cookie throws unauthenticated");

    // expired
    threw = null;
    try {
      verifySessionCookie({
        cookieValue: fresh.value,
        nowMs: 1_700_000_000_000 + 3600 * 1000 + 1,
      });
    } catch (e) { threw = e; }
    assert(threw instanceof SessionError && threw.kind === "unauthenticated",
      "expired cookie throws unauthenticated");
  });

  // missing secret
  await withAuthEnv({}, async () => {
    let threw = null;
    try {
      issueSessionCookie({
        ownerId: validOwnerId, email: validEmail, name: validName,
      });
    } catch (e) { threw = e; }
    assert(threw instanceof SessionError && threw.kind === "misconfigured",
      "missing secret throws misconfigured (issue)");

    threw = null;
    try { verifySessionCookie({ cookieValue: "anything.signature" }); }
    catch (e) { threw = e; }
    assert(threw instanceof SessionError && threw.kind === "misconfigured",
      "missing secret throws misconfigured (verify)");
  });

  // ── current-user via cookie ────────────────────────────────────────
  process.stdout.write("phase 5 — currentUserOrThrow via cookie path:\n");
  await withAuthEnv({
    APP_SESSION_SIGNING_SECRET: validSecret,
    // No DEV_OWNER set — proves cookie path doesn't need env fallback.
  }, async () => {
    const cookie = issueSessionCookie({
      ownerId: validOwnerId, email: validEmail, name: validName,
    });
    cookieStub.__setSessionCookieForTest(cookie.value);
    const user = await currentUserOrThrow();
    assert(user.id === validOwnerId, "cookie path returns user.id");
    assert(user.email === validEmail, "cookie path returns user.email");
    assert(user.name === validName, "cookie path returns user.name");
    assert(user.initials === "AL", "cookie path derives initials");
    assert(user.sendingAccount === null,
      "cookie path returns null sendingAccount (mock mode)");
  });

  // ── Bad cookie does NOT silently fall back to env ─────────────────
  process.stdout.write("phase 6 — bad cookie does NOT fall back to env:\n");
  await withAuthEnv({
    APP_SESSION_SIGNING_SECRET: validSecret,
    DEV_OWNER_ID: validOwnerId,
    DEV_OWNER_EMAIL: validEmail,
    DEV_OWNER_NAME: validName,
  }, async () => {
    cookieStub.__setSessionCookieForTest("totally-not-a-real-cookie");
    await assertAuthError("malformed cookie + valid env still 401",
      () => currentUserOrThrow(), "unauthenticated", AuthError);
  });

  // ── Expired cookie does NOT fall back to env ──────────────────────
  await withAuthEnv({
    APP_SESSION_SIGNING_SECRET: validSecret,
    DEV_OWNER_ID: validOwnerId,
    DEV_OWNER_EMAIL: validEmail,
    DEV_OWNER_NAME: validName,
  }, async () => {
    const cookie = issueSessionCookie({
      ownerId: validOwnerId, email: validEmail, name: validName,
      nowMs: 1_700_000_000_000, ttlSeconds: 60,
    });
    cookieStub.__setSessionCookieForTest(cookie.value);
    // Simulate "now is way past expiry" by issuing with a past TTL.
    // We can't fake the time on the auth seam directly, so instead we
    // build a cookie that's already expired by setting issuedAt far
    // back via a deliberately short TTL relative to now. Use a fresh
    // cookie that's already past expiry as of real-time `now`:
    const expired = issueSessionCookie({
      ownerId: validOwnerId, email: validEmail, name: validName,
      nowMs: Date.now() - 7200 * 1000, // 2h ago
      ttlSeconds: 60,                  // expired 119 minutes ago
    });
    cookieStub.__setSessionCookieForTest(expired.value);
    await assertAuthError("expired cookie + valid env still 401",
      () => currentUserOrThrow(), "unauthenticated", AuthError);
  });

  // ── Missing signing secret = misconfigured ────────────────────────
  process.stdout.write("phase 7 — missing signing secret propagates as misconfigured:\n");
  await withAuthEnv({
    DEV_OWNER_ID: validOwnerId,
    DEV_OWNER_EMAIL: validEmail,
    DEV_OWNER_NAME: validName,
    // APP_SESSION_SIGNING_SECRET intentionally unset.
  }, async () => {
    cookieStub.__setSessionCookieForTest("anything.signature");
    await assertAuthError(
      "cookie present + no secret = misconfigured",
      () => currentUserOrThrow(),
      "misconfigured",
      AuthError,
    );
  });

  process.stdout.write("\nall current-user auth checks passed\n");
} catch (error) {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await cleanup().catch(() => {});
}
