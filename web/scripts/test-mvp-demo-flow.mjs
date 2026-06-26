// End-to-end MVP demo smoke. Boots the mock-mode app, signs in through the
// dev-session route, visits the user-facing pages, exercises the Workspace
// draft + delivery queue boundary, checks the command-channel review pointer,
// and signs out. No Docker, no real Google/Gmail/Telegram, no external calls.
//
// Run via: pnpm test:mvp-demo

import { rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const PORT = Number(process.env.TEST_MVP_DEMO_PORT ?? 3230);
const BASE = `http://localhost:${PORT}`;
const nextBin = resolve(projectRoot, "node_modules/.bin/next");

const testUser = {
  id: "99999999-9999-4999-8999-999999999999",
  email: "mvp-demo@example.test",
  name: "MVP Demo",
  initials: "MD",
};

const SESSION_SECRET = "test-mvp-demo-app-session-secret-min-32-chars";
let sessionCookie = "";

function normalize(html) {
  return html
    .replace(/<!--\s*-->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function cookieHeader() {
  return sessionCookie ? { cookie: `keepsake_session=${sessionCookie}` } : {};
}

function assertNoAppError(label, body) {
  check(`${label} has no runtime error overlay`,
    !body.includes("Runtime Error") && !body.includes("Application error"));
}

async function waitForReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/signin`);
      if (res.status < 500) return;
    } catch {}
    await wait(500);
  }
  throw new Error(`dev server did not become ready at ${BASE}`);
}

async function getHtml(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      ...cookieHeader(),
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: normalize(text), headers: res.headers };
}

async function postJson(path, body, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    ...options,
    headers: {
      "content-type": "application/json",
      ...cookieHeader(),
      ...(options.headers ?? {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, body: text, json, headers: res.headers };
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

rmSync(resolve(projectRoot, ".next"), { recursive: true, force: true });

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
  process.stdout.write(`booting MVP demo smoke on :${PORT}...\n`);
  await waitForReady();
  process.stdout.write("server ready, running demo assertions:\n");

  const signIn = await getHtml("/signin?returnTo=%2Fworkspace%3Fperson%3Dp-lin");
  check("signin page -> 200", signIn.status === 200, `status=${signIn.status}`);
  check("signin page shows dev CTA", signIn.body.includes("Continue as dev owner"));
  check("signin page frames ReMaster workspace",
    signIn.body.includes("account/contact workspace"));
  assertNoAppError("signin page", signIn.body);

  const signInResponse = await fetch(
    `${BASE}/api/auth/dev-session/start?returnTo=%2Fworkspace%3Fperson%3Dp-lin`,
    { method: "POST", redirect: "manual" },
  );
  check("dev-session start -> 303", signInResponse.status === 303,
    `status=${signInResponse.status}`);
  check("dev-session redirects to Workspace",
    (signInResponse.headers.get("location") ?? "").endsWith("/workspace?person=p-lin"));
  sessionCookie = (signInResponse.headers.get("set-cookie") ?? "")
    .match(/keepsake_session=([^;]+)/)?.[1] ?? "";
  check("dev-session sets keepsake_session", sessionCookie.length > 20);

  const pages = [
    { path: "/", label: "Home", expected: "MVP Demo" },
    { path: "/people", label: "People", expected: "5 contacts across client, partner, prospect, investor, and personal segments" },
    { path: "/workspace?person=p-lin", label: "Workspace", expected: "Account outreach for Lin" },
    { path: "/history", label: "History", expected: "Account/contact outreach history" },
    { path: "/profile", label: "Profile", expected: "OUTREACH WORKFLOW" },
  ];

  for (const page of pages) {
    const res = await getHtml(page.path);
    check(`${page.label} page -> 200`, res.status === 200, `status=${res.status}`);
    check(`${page.label} page renders expected copy`, res.body.includes(page.expected));
    assertNoAppError(`${page.label} page`, res.body);
  }

  const workspace = await getHtml("/workspace?person=p-lin");
  check("Workspace includes icon fallback attrs",
    workspace.body.includes('width="1em"') && workspace.body.includes('stroke="currentColor"'));
  check("Workspace includes recipient email input",
    workspace.body.includes('data-testid="recipient-email-input"'));

  const draft = await postJson("/api/drafts", {
    personId: "p-lin",
    occasionId: "occ-lin-anniv",
    userInstruction: "",
  });
  check("POST /api/drafts -> 200", draft.status === 200, `status=${draft.status}`);
  check("draft returns subject", typeof draft.json?.subject === "string" && draft.json.subject.length > 0);
  check("draft returns paragraphs", Array.isArray(draft.json?.paragraphs) && draft.json.paragraphs.length > 0);

  const queued = await postJson("/api/deliveries", {
    personId: "p-lin",
    occasionId: "occ-lin-anniv",
    channel: "email",
    recipientEmail: "lin@example.test",
  });
  check("POST /api/deliveries -> 202", queued.status === 202, `status=${queued.status}`);
  check("delivery queue returns queued status", queued.json?.status === "queued");
  check("delivery queue never echoes recipient email",
    !queued.body.includes("lin@example.test"));

  const followup = await postJson("/api/channels/mock", {
    text: "最近有什么需要跟进的关系吗？",
  }, { headers: {} });
  check("mock channel follow-up -> 200", followup.status === 200, `status=${followup.status}`);
  check("mock channel follow-up returns reviewUrl", followup.json?.reviewUrl === "/people");
  check("mock channel follow-up is ReMaster-framed",
    String(followup.json?.text ?? "").includes("ReMaster")
      && !String(followup.json?.text ?? "").includes("Keepsake"));
  check("mock channel follow-up does not claim execution",
    !/\b(sent|delivered|queued)\b/i.test(followup.body));

  const compose = await postJson("/api/channels/mock", {
    text: "帮我给 Helen 发一个邮件，她今天升职了，我要祝福她",
  }, { headers: {} });
  check("mock channel compose -> 200", compose.status === 200, `status=${compose.status}`);
  check("mock channel compose requires review", compose.json?.status === "needs_review");
  check("mock channel compose is ReMaster-framed",
    String(compose.json?.text ?? "").includes("ReMaster")
      && !String(compose.json?.text ?? "").includes("Keepsake"));
  check("mock channel compose opens Workspace", String(compose.json?.reviewUrl ?? "").startsWith("/workspace"));
  check("mock channel compose extracts recipient", compose.json?.suggestedAction?.recipientHint === "Helen");

  const signOut = await fetch(`${BASE}/api/auth/signout`, {
    method: "POST",
    headers: cookieHeader(),
    redirect: "manual",
  });
  check("signout -> 303", signOut.status === 303, `status=${signOut.status}`);
  check("signout redirects to signin",
    (signOut.headers.get("location") ?? "").endsWith("/signin"));
  check("signout clears session cookie",
    /keepsake_session=.*(?:Max-Age=0|expires=Thu, 01 Jan 1970)/i
      .test(signOut.headers.get("set-cookie") ?? ""));

  sessionCookie = "";
  const afterSignout = await getHtml("/profile", { redirect: "manual" });
  check("profile after signout redirects", afterSignout.status === 307,
    `status=${afterSignout.status}`);
  check("profile redirect points to signin",
    (afterSignout.headers.get("location") ?? "").includes("/signin?returnTo=%2Fprofile"));
} catch (error) {
  process.stdout.write(`harness error: ${error?.message ?? error}\n`);
  if (serverError) process.stdout.write(serverError);
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
