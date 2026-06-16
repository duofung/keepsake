// Smoke test for the Gmail OAuth route stubs. These endpoints define the HTTP
// contract before Google API, OAuth state, token storage, or Gmail send
// paths exist.
//
// Run via: pnpm test:oauth

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const PORT = Number(process.env.TEST_GMAIL_OAUTH_PORT ?? 3145);
const nextBin = resolve(projectRoot, "node_modules/.bin/next");
const AUTH_ENV_KEYS = [
  "DEV_OWNER_ID",
  "DEV_OWNER_EMAIL",
  "DEV_OWNER_NAME",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_REDIRECT_URI",
];

const validAuth = {
  DEV_OWNER_ID: "77777777-7777-4777-8777-777777777777",
  DEV_OWNER_EMAIL: "oauth-owner@example.test",
  DEV_OWNER_NAME: "OAuth Owner",
};

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    process.stdout.write(`  ✗ ${name}${detail ? `  (${detail})` : ""}\n`);
    failures.push(name);
  }
}

function childEnv(authEnv) {
  const env = {
    ...process.env,
    BROWSER: "none",
    NEXT_TELEMETRY_DISABLED: "1",
  };

  for (const key of AUTH_ENV_KEYS) {
    delete env[key];
  }

  return { ...env, ...authEnv };
}

async function waitForReady(baseUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await fetch(`${baseUrl}/api/oauth/gmail/start`);
      return;
    } catch {}

    await wait(500);
  }

  throw new Error(`dev server did not become ready at ${baseUrl}`);
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    wait(3_000).then(() => false),
  ]);

  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

async function fetchJson(baseUrl, path) {
  const res = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
  const body = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;

  return { status: res.status, body };
}

async function fetchResponse(baseUrl, path) {
  return fetch(`${baseUrl}${path}`, { redirect: "manual" });
}

async function runServer({ name, port, authEnv, assertions }) {
  const baseUrl = `http://localhost:${port}`;
  const child = spawn(nextBin, ["dev", "--port", String(port)], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv(authEnv),
  });

  let serverError = "";
  child.stderr.on("data", (b) => { serverError += b.toString(); });

  try {
    process.stdout.write(`booting next dev on :${port} for ${name}...\n`);
    await waitForReady(baseUrl);
    await assertions(baseUrl);
  } catch (error) {
    process.stdout.write(`harness error for ${name}: ${error?.message ?? error}\n`);
    if (serverError) {
      process.stdout.write(serverError);
    }
    failures.push(name);
  } finally {
    await stopServer(child);
  }
}

process.stdout.write("running Gmail OAuth route stub checks:\n");

await runServer({
  name: "valid auth / unconfigured",
  port: PORT,
  authEnv: validAuth,
  async assertions(baseUrl) {
    const start = await fetchJson(baseUrl, "/api/oauth/gmail/start");
    check("start -> 501", start.status === 501, `status=${start.status}`);
    check("start code = not_configured", start.body?.code === "not_configured", JSON.stringify(start.body));

    const startWithReturnTo = await fetchJson(baseUrl, "/api/oauth/gmail/start?returnTo=/profile");
    check("start accepts returnTo", startWithReturnTo.status === 501, `status=${startWithReturnTo.status}`);

    const missingCallback = await fetchJson(baseUrl, "/api/oauth/gmail/callback");
    check("callback without code/state -> 400", missingCallback.status === 400, `status=${missingCallback.status}`);
    check("callback missing code = invalid_callback", missingCallback.body?.code === "invalid_callback", JSON.stringify(missingCallback.body));

    const deniedCallback = await fetchJson(baseUrl, "/api/oauth/gmail/callback?error=access_denied");
    check("callback provider error -> 400", deniedCallback.status === 400, `status=${deniedCallback.status}`);
    check("callback provider code = provider_error", deniedCallback.body?.code === "provider_error", JSON.stringify(deniedCallback.body));

    const validCallback = await fetchJson(baseUrl, "/api/oauth/gmail/callback?code=test-code&state=test-state");
    check("callback with code/state -> 501", validCallback.status === 501, `status=${validCallback.status}`);
    check("callback configured code = not_configured", validCallback.body?.code === "not_configured", JSON.stringify(validCallback.body));
  },
});

await runServer({
  name: "valid auth / configured start",
  port: PORT + 2,
  authEnv: {
    ...validAuth,
    GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
    GOOGLE_REDIRECT_URI: "__ORIGIN__/api/oauth/gmail/callback",
  },
  async assertions(baseUrl) {
    const start = await fetchResponse(baseUrl, "/api/oauth/gmail/start?returnTo=/workspace?person=p-lin");
    check("configured start -> 307", start.status === 307, `status=${start.status}`);

    const location = start.headers.get("location") ?? "";
    const redirect = new URL(location);
    check("configured start redirects to Google", redirect.origin === "https://accounts.google.com", location);
    check("configured start sets client_id", redirect.searchParams.get("client_id") === "test-client-id.apps.googleusercontent.com", location);
    check("configured start sets redirect_uri", redirect.searchParams.get("redirect_uri") === `${baseUrl}/api/oauth/gmail/callback`, location);
    check("configured start sets response_type=code", redirect.searchParams.get("response_type") === "code", location);
    check("configured start sets access_type=offline", redirect.searchParams.get("access_type") === "offline", location);
    check("configured start sets prompt=consent", redirect.searchParams.get("prompt") === "consent", location);
    check(
      "configured start sets gmail.send scope",
      redirect.searchParams.get("scope") === "https://www.googleapis.com/auth/gmail.send",
      location,
    );
    check("configured start sets state", Boolean(redirect.searchParams.get("state")), location);

    const setCookie = start.headers.get("set-cookie") ?? "";
    check("configured start sets oauth state cookie", /keepsake_gmail_oauth_state=/.test(setCookie), setCookie);
    check("oauth state cookie is httpOnly", /HttpOnly/i.test(setCookie), setCookie);
    check("oauth state cookie is sameSite lax", /SameSite=Lax/i.test(setCookie), setCookie);
    check("oauth state cookie is path root", /Path=\//i.test(setCookie), setCookie);

    const fallback = await fetchResponse(baseUrl, "/api/oauth/gmail/start?returnTo=https://evil.example");
    const fallbackLocation = fallback.headers.get("location") ?? "";
    const fallbackRedirect = new URL(fallbackLocation);
    check("configured start still redirects on unsafe returnTo", fallback.status === 307, `status=${fallback.status}`);
    check("configured start keeps Google redirect for unsafe returnTo", fallbackRedirect.origin === "https://accounts.google.com", fallbackLocation);

    const callback = await fetchJson(baseUrl, "/api/oauth/gmail/callback?code=test-code&state=test-state");
    check("configured callback with code/state still -> 501", callback.status === 501, `status=${callback.status}`);
    check("configured callback still not_configured", callback.body?.code === "not_configured", JSON.stringify(callback.body));
  },
});

await runServer({
  name: "missing auth",
  port: PORT + 1,
  authEnv: {},
  async assertions(baseUrl) {
    const start = await fetchJson(baseUrl, "/api/oauth/gmail/start");
    check("start without auth -> 401", start.status === 401, `status=${start.status}`);
    check("start without auth body", start.body?.error === "Unauthenticated", JSON.stringify(start.body));

    const callback = await fetchJson(baseUrl, "/api/oauth/gmail/callback?code=test-code&state=test-state");
    check("callback without auth -> 401", callback.status === 401, `status=${callback.status}`);
    check("callback without auth body", callback.body?.error === "Unauthenticated", JSON.stringify(callback.body));
  },
});

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall Gmail OAuth route stub checks passed\n");
}
