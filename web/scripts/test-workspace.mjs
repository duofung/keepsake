// Smoke test for the Workspace page. Boots `next dev` on an isolated port
// with dev auth env and verifies the server-rendered workspace shell includes
// recipient and sender identity. Draft generation still happens through the
// existing client-side route calls.
//
// Run via: pnpm test:workspace

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const PORT = Number(process.env.TEST_WORKSPACE_PORT ?? 3144);
const BASE = `http://localhost:${PORT}`;
const nextBin = resolve(projectRoot, "node_modules/.bin/next");

const testUser = {
  id: "66666666-6666-4666-8666-666666666666",
  email: "workspace-fixture@example.test",
  name: "Workspace Fixture",
  initials: "WF",
};

const SESSION_SECRET = "test-workspace-app-session-secret-min-32-chars";
let sessionCookie = "";

function normalize(html) {
  return html
    .replace(/<!--\s*-->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function waitForReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/workspace?person=p-lin`);
      if (res.status < 500) return;
    } catch {}

    await wait(500);
  }

  throw new Error(`dev server did not become ready at ${BASE}`);
}

async function getWorkspace() {
  const res = await fetch(`${BASE}/workspace?person=p-lin`, {
    headers: sessionCookie ? { cookie: `keepsake_session=${sessionCookie}` } : {},
  });
  const text = await res.text();
  return { status: res.status, body: normalize(text) };
}

async function mintSession() {
  const res = await fetch(`${BASE}/api/auth/dev-session/start`, {
    method: "POST",
  });
  if (res.status !== 200) {
    throw new Error(`dev-session/start failed: status=${res.status}`);
  }
  const setCookie = res.headers.get("set-cookie") ?? "";
  sessionCookie = setCookie.match(/keepsake_session=([^;]+)/)?.[1] ?? "";
  if (!sessionCookie) throw new Error("dev-session/start did not set a cookie");
}

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    process.stdout.write(`  ✗ ${name}${detail ? `  (${detail})` : ""}\n`);
    failures.push(name);
  }
}

const child = spawn(nextBin, ["dev", "--port", String(PORT)], {
  cwd: projectRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    BROWSER: "none",
    DEV_OWNER_ID: testUser.id,
    DEV_OWNER_EMAIL: testUser.email,
    DEV_OWNER_NAME: testUser.name,
    APP_SESSION_SIGNING_SECRET: SESSION_SECRET,
    ENABLE_DEV_SESSION_ROUTES: "1",
    KEEPSAKE_DATA_SOURCE: "mock",
    NEXT_TELEMETRY_DISABLED: "1",
  },
});

let serverError = "";
child.stderr.on("data", (b) => { serverError += b.toString(); });
child.on("exit", (code) => {
  if (code !== null && code !== 0 && failures.length === 0 && serverError) {
    process.stdout.write(`(dev server exited with ${code})\n${serverError}\n`);
  }
});

try {
  process.stdout.write(`booting next dev on :${PORT}...\n`);
  await waitForReady();
  await mintSession();
  process.stdout.write("server ready, running assertions:\n");

  const { status, body } = await getWorkspace();

  check("GET /workspace?person=p-lin -> 200", status === 200, `status=${status}`);
  check("renders recipient header", body.includes("Outreach to Lin"));
  check("renders relationship subtitle", body.includes("Partner") && body.includes("together 12 years"));
  check("renders compose To row", body.includes("To") && body.includes("Lin"));
  check("renders sender From row", body.includes("From"));
  check("renders sender name", body.includes(testUser.name));
  check("renders sender email", body.includes(testUser.email));
  check("renders sender initials", body.includes(testUser.initials));
  check("renders missing sender configuration", body.includes("sender not configured"));
  check("keeps tone controls", body.includes("Tone:"));
  check("keeps send footer", body.includes("Queue now, or hold for the right day"));
  check("renders Queue email button", body.includes("Queue email"));
  check("renders Queue print card button", body.includes("Queue print card"));
  check("renders direct message editor", body.includes('data-testid="message-body-editor"'));
  check("message editor is not hidden behind an edit mode", !body.includes('data-testid="message-body-edit-toggle"'));
  check("message editor is not preview-only", !body.includes('data-testid="message-body-preview"'));
  check("renders card as its own content format", body.includes("PRINT VERSION"));
  check("card is no longer labelled as an attachment", !body.includes("ATTACHED TO THIS EMAIL"));
  check("does not render fake attachments section", !body.includes("ATTACHMENTS"));
  check("does not render fake attachments empty state", !body.includes("No files attached"));
  // P9-A: icons must have inline SVG fallbacks, not only CSS classes.
  // Without these, a dev-cache/CSS load failure turns the sprite paths into
  // huge black default SVGs in the visible app.
  check("icons carry inline width/height fallback",
    body.includes('width="1em"') && body.includes('height="1em"'));
  check("icons carry inline stroke/fill fallback",
    body.includes('fill="none"') && body.includes('stroke="currentColor"'));
  // P5-preA: the To row now carries an email input. The label "To" and the
  // person name must still render alongside the new field.
  check("renders recipient email input", body.includes('data-testid="recipient-email-input"'));
  check("recipient email input uses type=email",
    /data-testid="recipient-email-input"[\s\S]{0,200}type="email"|type="email"[\s\S]{0,200}data-testid="recipient-email-input"/.test(body));
  check("recipient email input has placeholder", body.includes('placeholder="recipient@example.com"'));
  check("To row still renders person name alongside the input", body.includes(">Lin<"));
  // Guard against re-introducing the old fake-success copy: the queue
  // boundary now returns 202 "queued", and the UI must reflect that.
  check("no fake 'Email sent to' copy", !body.includes("Email sent to"));
  check("no fake 'On its way' copy", !body.includes("On its way to"));
  check("does not mention Gmail", !/gmail/i.test(body));
  // P4-B save-status pill — initial SSR is idle, so the affordance copy
  // must be present in the rendered HTML. This guards both the
  // status="idle" path and the fact that the autosave indicator hasn't
  // been quietly removed.
  check("renders save-status affordance", body.includes("Edits save automatically"));
  check("save-status idle marker present", body.includes('data-save-status="idle"'));
} catch (error) {
  process.stdout.write(`harness error: ${error?.message ?? error}\n`);
  if (serverError) {
    process.stdout.write(serverError);
  }
  failures.push("harness");
} finally {
  child.kill("SIGTERM");
  await wait(400);
  if (!child.killed) child.kill("SIGKILL");
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall ok\n");
  process.exit(0);
}
