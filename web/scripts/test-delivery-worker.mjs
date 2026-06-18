// Default delivery-worker smoke. Docker-free. Exercises the Gmail send
// transport (`lib/server/delivery-worker/gmail-transport.server.ts`)
// directly against a local Node HTTP stub. The DB-backed worker
// orchestration is covered by `pnpm test:db:delivery-worker`.
//
// Coverage:
//   1. buildPlainTextMime — subject, body, headers, Date, Message-ID
//   2. sendGmailPlainText — token exchange + send happy path
//   3. token endpoint returns invalid_grant -> GmailTransportError "token_invalid"
//   4. Gmail send returns 5xx          -> GmailTransportError "gmail_send_error"
//   5. send response is not JSON       -> GmailTransportError "transport_error"
//   6. token endpoint network error    -> GmailTransportError "transport_error"

import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = normalize(join(__dirname, ".."));
const require = createRequire(import.meta.url);

const failures = [];
function check(name, cond, detail = "") {
  if (cond) process.stdout.write(`  ✓ ${name}\n`);
  else {
    process.stdout.write(`  ✗ ${name}${detail ? `  (${detail})` : ""}\n`);
    failures.push(name);
  }
}

async function loadDeliveryWorkerModules() {
  const tempRoot = join(projectRoot, ".next", "test-delivery-worker");
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, "run-"));
  async function transpile(relPath) {
    const src = await readFile(join(projectRoot, relPath), "utf8");
    const cleaned = src.replace(/^import "server-only";\n/m, "");
    const compiled = ts.transpileModule(cleaned, {
      fileName: relPath,
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const out = join(
      tempDir,
      relPath.replace(/[\/\\]/g, "_").replace(/\.ts$/, ".cjs"),
    );
    await writeFile(out, compiled);
    return out;
  }
  const transportPath = await transpile(
    "lib/server/delivery-worker/gmail-transport.server.ts",
  );
  const runtimePath = await transpile(
    "lib/server/delivery-worker/runtime.server.ts",
  );
  return {
    transport: require(transportPath),
    runtime: require(runtimePath),
    cleanup: () => rm(tempDir, { force: true, recursive: true }),
  };
}

// Stub HTTP server that serves both:
//   POST /token              (Google OAuth token endpoint)
//   POST /gmail/v1/users/me/messages/send
// Each test phase configures the next response via the rig.

const STUB_PORT = Number(process.env.TEST_DELIVERY_WORKER_STUB_PORT ?? 3180);
const rig = {
  tokenCalls: [],
  sendCalls: [],
  nextTokenResponse: null,
  nextSendResponse: null,
  closeTokenOnRequest: false,
};

function startStub() {
  return new Promise((resolveStarted, reject) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (req.method === "POST" && req.url?.endsWith("/token")) {
          rig.tokenCalls.push({
            body,
            authHeader: req.headers.authorization ?? null,
          });
          if (rig.closeTokenOnRequest) {
            rig.closeTokenOnRequest = false;
            res.socket?.destroy();
            return;
          }
          const r = rig.nextTokenResponse ?? {
            status: 200,
            body: { access_token: "stub-access", token_type: "Bearer", expires_in: 3600 },
          };
          rig.nextTokenResponse = null;
          res.statusCode = r.status;
          res.setHeader("content-type", "application/json");
          res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
          return;
        }
        if (req.method === "POST" && req.url?.endsWith("/messages/send")) {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch {}
          rig.sendCalls.push({
            parsed,
            authHeader: req.headers.authorization ?? null,
          });
          const r = rig.nextSendResponse ?? {
            status: 200,
            body: { id: "msg-stub-1", threadId: "thr-1" },
          };
          rig.nextSendResponse = null;
          res.statusCode = r.status;
          res.setHeader("content-type", "application/json");
          res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
    });
    server.on("error", reject);
    server.listen(STUB_PORT, "127.0.0.1", () => resolveStarted(server));
  });
}

const { transport: mod, runtime: runtimeMod, cleanup } = await loadDeliveryWorkerModules();
const stub = await startStub();
process.stdout.write(`stub provider listening on :${STUB_PORT}\n`);

const STUB_BASE = `http://127.0.0.1:${STUB_PORT}`;
const STUB_TOKEN_ENDPOINT = `${STUB_BASE}/token`;

process.env.GOOGLE_CLIENT_ID = "stub-client-id";
process.env.GOOGLE_CLIENT_SECRET = "stub-client-secret";
process.env.GOOGLE_TOKEN_ENDPOINT = STUB_TOKEN_ENDPOINT;
process.env.KEEPSAKE_GMAIL_API_BASE = STUB_BASE;

const {
  buildPlainTextMime,
  sendGmailPlainText,
  GmailTransportError,
  WorkerMisconfiguredError,
  assertGmailTransportConfig,
} = mod;

function freshRig() {
  rig.tokenCalls.length = 0;
  rig.sendCalls.length = 0;
  rig.nextTokenResponse = null;
  rig.nextSendResponse = null;
  rig.closeTokenOnRequest = false;
}

try {
  // ── 1. buildPlainTextMime ───────────────────────────────────────────
  process.stdout.write("phase 1 — buildPlainTextMime:\n");
  {
    const mime = buildPlainTextMime({
      fromEmail: "from@example.test",
      toEmail: "lin@example.test",
      subject: "12 years and counting",
      paragraphs: [{ text: "Lin," }, { text: "Twelve years today." }, { text: "— always" }],
      messageIdSeed: "abc-123",
      date: new Date("2026-06-17T12:00:00Z"),
    });
    check("mime has From header", /From: from@example\.test/.test(mime));
    check("mime has To header", /To: lin@example\.test/.test(mime));
    check("mime has ASCII subject as-is",
      /Subject: 12 years and counting/.test(mime));
    check("mime has fixed Date", /Date: Wed, 17 Jun 2026 12:00:00 GMT/.test(mime));
    check("mime has deterministic Message-ID",
      mime.includes("Message-ID: <delivery-abc-123@keepsake.local>"));
    check("mime has UTF-8 content type",
      mime.includes("Content-Type: text/plain; charset=UTF-8"));
    check("mime has 8bit transfer encoding",
      mime.includes("Content-Transfer-Encoding: 8bit"));
    check("mime joins paragraphs with blank lines",
      mime.includes("Lin,\r\n\r\nTwelve years today.\r\n\r\n— always"));
    check("mime separates headers from body with CRLF CRLF",
      /\r\n\r\nLin,/.test(mime));
  }
  {
    const mime = buildPlainTextMime({
      fromEmail: "from@example.test",
      toEmail: "lin@example.test",
      subject: "Selamat Hari Raya 🌙",
      paragraphs: [{ text: "Hi" }],
      messageIdSeed: "x",
      date: new Date(0),
    });
    check("non-ASCII subject uses RFC 2047 encoded-word",
      /Subject: =\?UTF-8\?B\?.+\?=/.test(mime),
      mime.split("\r\n").find((l) => l.startsWith("Subject:")));
  }

  // ── 2. send happy path ──────────────────────────────────────────────
  process.stdout.write("phase 2 — send happy path:\n");
  freshRig();
  {
    const res = await sendGmailPlainText({
      refreshToken: "stub-refresh",
      email: {
        fromEmail: "from@example.test",
        toEmail: "lin@example.test",
        subject: "Hello",
        paragraphs: [{ text: "Hi Lin." }],
        messageIdSeed: "happy-1",
        date: new Date(0),
      },
    });
    check("send returns providerMessageId from stub",
      res.providerMessageId === "msg-stub-1");
    check("token endpoint was called exactly once",
      rig.tokenCalls.length === 1);
    check("token call uses refresh_token grant",
      /grant_type=refresh_token/.test(rig.tokenCalls[0].body));
    check("token call includes the refresh token",
      /refresh_token=stub-refresh/.test(rig.tokenCalls[0].body));
    check("send endpoint was called exactly once",
      rig.sendCalls.length === 1);
    check("send call carries bearer access token",
      rig.sendCalls[0].authHeader === "Bearer stub-access");
    check("send call body has raw base64url",
      typeof rig.sendCalls[0].parsed?.raw === "string"
        && rig.sendCalls[0].parsed.raw.length > 0
        && !rig.sendCalls[0].parsed.raw.includes("="));
    // Decode the raw to confirm MIME made it across cleanly
    {
      const padded = rig.sendCalls[0].parsed.raw
        .replace(/-/g, "+").replace(/_/g, "/")
        .padEnd(Math.ceil(rig.sendCalls[0].parsed.raw.length / 4) * 4, "=");
      const decoded = Buffer.from(padded, "base64").toString("utf8");
      check("raw decodes to the same MIME the function produced",
        decoded.includes("To: lin@example.test")
          && decoded.includes("Subject: Hello")
          && decoded.includes("Hi Lin."));
    }
  }

  // ── 3. token invalid_grant → token_invalid ──────────────────────────
  process.stdout.write("phase 3 — token invalid_grant:\n");
  freshRig();
  rig.nextTokenResponse = {
    status: 400,
    body: { error: "invalid_grant", error_description: "Token has been expired or revoked." },
  };
  {
    let err = null;
    try {
      await sendGmailPlainText({
        refreshToken: "stub-refresh",
        email: {
          fromEmail: "from@example.test", toEmail: "lin@example.test",
          subject: "x", paragraphs: [{ text: "x" }],
          messageIdSeed: "z", date: new Date(0),
        },
      });
    } catch (caught) { err = caught; }
    check("token invalid_grant throws GmailTransportError",
      err instanceof GmailTransportError);
    check("reason is token_invalid", err?.reason === "token_invalid");
    check("send endpoint NOT called when token fails",
      rig.sendCalls.length === 0);
  }

  // ── 4. Gmail send returns 5xx → gmail_send_error ───────────────────
  process.stdout.write("phase 4 — Gmail send 5xx:\n");
  freshRig();
  rig.nextSendResponse = {
    status: 500,
    body: { error: { code: 500, message: "Internal Server Error" } },
  };
  {
    let err = null;
    try {
      await sendGmailPlainText({
        refreshToken: "stub-refresh",
        email: {
          fromEmail: "from@example.test", toEmail: "lin@example.test",
          subject: "x", paragraphs: [{ text: "x" }],
          messageIdSeed: "z", date: new Date(0),
        },
      });
    } catch (caught) { err = caught; }
    check("send 5xx throws GmailTransportError",
      err instanceof GmailTransportError);
    check("reason is gmail_send_error", err?.reason === "gmail_send_error");
    check("send error does NOT leak Gmail URL into message",
      typeof err?.message === "string" && !err.message.includes("gmail.googleapis.com"));
  }

  // ── 5. malformed (non-JSON) send response → transport_error ────────
  process.stdout.write("phase 5 — malformed send response:\n");
  freshRig();
  rig.nextSendResponse = { status: 200, body: "this-is-not-json" };
  {
    let err = null;
    try {
      await sendGmailPlainText({
        refreshToken: "stub-refresh",
        email: {
          fromEmail: "from@example.test", toEmail: "lin@example.test",
          subject: "x", paragraphs: [{ text: "x" }],
          messageIdSeed: "z", date: new Date(0),
        },
      });
    } catch (caught) { err = caught; }
    check("malformed send body throws GmailTransportError",
      err instanceof GmailTransportError);
    check("reason is transport_error", err?.reason === "transport_error");
  }

  // ── 6. token endpoint network error ────────────────────────────────
  process.stdout.write("phase 6 — token network error:\n");
  freshRig();
  rig.closeTokenOnRequest = true;
  {
    let err = null;
    try {
      await sendGmailPlainText({
        refreshToken: "stub-refresh",
        email: {
          fromEmail: "from@example.test", toEmail: "lin@example.test",
          subject: "x", paragraphs: [{ text: "x" }],
          messageIdSeed: "z", date: new Date(0),
        },
      });
    } catch (caught) { err = caught; }
    check("token network error throws GmailTransportError",
      err instanceof GmailTransportError);
    check("reason is transport_error", err?.reason === "transport_error");
    check("send was NOT called", rig.sendCalls.length === 0);
  }

  // ── 7. assertGmailTransportConfig — fail-fast on missing env ───────
  process.stdout.write("phase 7 — assertGmailTransportConfig fail-fast:\n");
  {
    const savedId = process.env.GOOGLE_CLIENT_ID;
    const savedSecret = process.env.GOOGLE_CLIENT_SECRET;

    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    let err = null;
    try { assertGmailTransportConfig(); }
    catch (caught) { err = caught; }
    check("missing both env vars throws WorkerMisconfiguredError",
      err instanceof WorkerMisconfiguredError);
    check("error.missing lists GOOGLE_CLIENT_ID",
      Array.isArray(err?.missing) && err.missing.includes("GOOGLE_CLIENT_ID"));
    check("error.missing lists GOOGLE_CLIENT_SECRET",
      Array.isArray(err?.missing) && err.missing.includes("GOOGLE_CLIENT_SECRET"));

    process.env.GOOGLE_CLIENT_ID = "stub-client-id";
    err = null;
    try { assertGmailTransportConfig(); }
    catch (caught) { err = caught; }
    check("missing only secret still throws",
      err instanceof WorkerMisconfiguredError);
    check("error.missing lists only GOOGLE_CLIENT_SECRET",
      err?.missing?.length === 1 && err.missing[0] === "GOOGLE_CLIENT_SECRET");

    // Restore for the rest of the suite + any later phases.
    process.env.GOOGLE_CLIENT_ID = savedId;
    process.env.GOOGLE_CLIENT_SECRET = savedSecret;
    let ok = true;
    try { assertGmailTransportConfig(); }
    catch { ok = false; }
    check("config valid after restoring env", ok === true);
  }

  // ── 9-13. runDeliveryWorkerLoop ────────────────────────────────────
  // The loop is pure logic; we inject `tick` + `recover` so we don't
  // need DB or HTTP. Each phase configures a sequence of fake results.
  process.stdout.write("phase 9 — loop stops on nothing_to_do (empty queue):\n");
  {
    const { runDeliveryWorkerLoop } = runtimeMod;
    let tickCount = 0;
    const tick = async () => {
      tickCount++;
      return { status: "nothing_to_do" };
    };
    const summary = await runDeliveryWorkerLoop(
      { maxTicks: 5 },
      { tick, recover: async () => [], preflight: () => [] },
    );
    check("stopReason is empty", summary.stopReason === "empty");
    check("did exactly one tick", summary.ticks === 1 && tickCount === 1);
    check("sent / failed / recovered are zero",
      summary.sent === 0 && summary.failed === 0 && summary.recovered === 0);
  }

  process.stdout.write("phase 10 — loop drains multiple sent then stops:\n");
  {
    const { runDeliveryWorkerLoop } = runtimeMod;
    const sequence = [
      { status: "sent", deliveryId: "a", providerMessageId: "g-1" },
      { status: "sent", deliveryId: "b", providerMessageId: "g-2" },
      { status: "sent", deliveryId: "c", providerMessageId: "g-3" },
      { status: "nothing_to_do" },
    ];
    let i = 0;
    const tick = async () => sequence[i++];
    const summary = await runDeliveryWorkerLoop(
      { maxTicks: 10 },
      { tick, recover: async () => [], preflight: () => [] },
    );
    check("ticks counts every call including the final empty",
      summary.ticks === 4, `ticks=${summary.ticks}`);
    check("sent === 3", summary.sent === 3);
    check("stopReason is empty", summary.stopReason === "empty");
  }

  process.stdout.write("phase 11 — misconfigured halts immediately:\n");
  {
    const { runDeliveryWorkerLoop } = runtimeMod;
    let tickCount = 0;
    const tick = async () => {
      tickCount++;
      return {
        status: "misconfigured",
        missing: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
      };
    };
    const summary = await runDeliveryWorkerLoop(
      { maxTicks: 5 },
      { tick, recover: async () => [], preflight: () => [] },
    );
    check("stopReason is misconfigured",
      summary.stopReason === "misconfigured");
    check("missing list surfaced",
      Array.isArray(summary.missing) && summary.missing.length === 2);
    check("only one tick made it through",
      summary.ticks === 1 && tickCount === 1);
  }

  process.stdout.write("phase 12 — max_ticks caps a busy queue:\n");
  {
    const { runDeliveryWorkerLoop } = runtimeMod;
    let tickCount = 0;
    const tick = async () => {
      tickCount++;
      return { status: "sent", deliveryId: `id-${tickCount}`, providerMessageId: "x" };
    };
    const summary = await runDeliveryWorkerLoop(
      { maxTicks: 3 },
      { tick, recover: async () => [], preflight: () => [] },
    );
    check("stops at the budget", summary.ticks === 3);
    check("stopReason is max_ticks", summary.stopReason === "max_ticks");
    check("sent === 3 (every tick succeeded)", summary.sent === 3);
  }

  process.stdout.write("phase 13 — recovery runs once, before ticks:\n");
  {
    const { runDeliveryWorkerLoop } = runtimeMod;
    let recoverCalls = 0;
    let recoverArg = null;
    const tick = async () => ({ status: "nothing_to_do" });
    const recover = async (sec) => {
      recoverCalls++;
      recoverArg = sec;
      return ["r-1", "r-2", "r-3"];
    };
    const summary = await runDeliveryWorkerLoop(
      { maxTicks: 5, recovery: { staleAfterSeconds: 600 } },
      { tick, recover, preflight: () => [] },
    );
    check("recover called exactly once", recoverCalls === 1);
    check("recover got the configured threshold", recoverArg === 600);
    check("recovered count matches returned ids", summary.recovered === 3);
    check("stopReason is empty (nothing left after recovery)",
      summary.stopReason === "empty");
  }

  process.stdout.write("phase 14 — stopOnFailure halts on first failed:\n");
  {
    const { runDeliveryWorkerLoop } = runtimeMod;
    const seq = [
      { status: "sent", deliveryId: "a", providerMessageId: "g-1" },
      { status: "failed", deliveryId: "b", reason: "gmail_send_error" },
      { status: "sent", deliveryId: "c", providerMessageId: "g-3" }, // should never run
    ];
    let i = 0;
    const tick = async () => seq[i++];
    const summary = await runDeliveryWorkerLoop(
      { maxTicks: 5, stopOnFailure: true },
      { tick, recover: async () => [], preflight: () => [] },
    );
    check("stopReason is stopped_on_failure",
      summary.stopReason === "stopped_on_failure");
    check("ticks is 2", summary.ticks === 2);
    check("sent is 1, failed is 1",
      summary.sent === 1 && summary.failed === 1);
    check("third tick was NOT reached", i === 2);
  }

  process.stdout.write("phase 15 — without stopOnFailure, loop drains past failures:\n");
  {
    const { runDeliveryWorkerLoop } = runtimeMod;
    const seq = [
      { status: "failed", deliveryId: "a", reason: "gmail_send_error" },
      { status: "sent", deliveryId: "b", providerMessageId: "g-2" },
      { status: "failed", deliveryId: "c", reason: "transport_error" },
      { status: "nothing_to_do" },
    ];
    let i = 0;
    const tick = async () => seq[i++];
    const summary = await runDeliveryWorkerLoop(
      { maxTicks: 10 },
      { tick, recover: async () => [], preflight: () => [] },
    );
    check("ticks is 4", summary.ticks === 4);
    check("sent === 1, failed === 2",
      summary.sent === 1 && summary.failed === 2);
    check("stopReason is empty",
      summary.stopReason === "empty");
  }

  process.stdout.write("phase 16 — fatal tick error is caught:\n");
  {
    const { runDeliveryWorkerLoop } = runtimeMod;
    const tick = async () => { throw new Error("boom"); };
    const summary = await runDeliveryWorkerLoop(
      { maxTicks: 3 },
      { tick, recover: async () => [], preflight: () => [] },
    );
    check("stopReason is fatal_error",
      summary.stopReason === "fatal_error");
    check("fatalError mentions the cause",
      typeof summary.fatalError === "string" && summary.fatalError.includes("boom"));
    check("ticks is 0 (nothing finalised)", summary.ticks === 0);
  }

  process.stdout.write("phase 17 — fatal recovery error halts before any tick:\n");
  {
    const { runDeliveryWorkerLoop } = runtimeMod;
    let tickCount = 0;
    const tick = async () => { tickCount++; return { status: "nothing_to_do" }; };
    const recover = async () => { throw new Error("recovery boom"); };
    const summary = await runDeliveryWorkerLoop(
      { maxTicks: 3, recovery: { staleAfterSeconds: 60 } },
      { tick, recover, preflight: () => [] },
    );
    check("stopReason is fatal_error",
      summary.stopReason === "fatal_error");
    check("ticks is 0 (recovery failed before any tick)",
      summary.ticks === 0 && tickCount === 0);
    check("fatalError mentions recovery",
      typeof summary.fatalError === "string"
        && summary.fatalError.includes("recovery boom"));
  }

  process.stdout.write("phase 18 — invalid maxTicks is a no-op cap:\n");
  {
    const { runDeliveryWorkerLoop } = runtimeMod;
    let tickCount = 0;
    const tick = async () => { tickCount++; return { status: "nothing_to_do" }; };
    const summary = await runDeliveryWorkerLoop(
      { maxTicks: 0 },
      { tick, recover: async () => [], preflight: () => [] },
    );
    check("zero maxTicks does NOT call tick",
      tickCount === 0 && summary.ticks === 0);
    check("stopReason is max_ticks",
      summary.stopReason === "max_ticks");
  }

  process.stdout.write("phase 19 — preflight gates recovery + ticks:\n");
  {
    const { runDeliveryWorkerLoop } = runtimeMod;
    let tickCalls = 0;
    let recoverCalls = 0;
    const tick = async () => {
      tickCalls++;
      return { status: "nothing_to_do" };
    };
    const recover = async (_sec) => {
      recoverCalls++;
      return ["should-never-be-recovered"];
    };
    const preflight = () => ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
    const summary = await runDeliveryWorkerLoop(
      { maxTicks: 5, recovery: { staleAfterSeconds: 600 } },
      { tick, recover, preflight },
    );
    check("stopReason is misconfigured",
      summary.stopReason === "misconfigured", JSON.stringify(summary));
    check("missing list propagated from preflight",
      Array.isArray(summary.missing) && summary.missing.length === 2);
    check("recover was NOT called",
      recoverCalls === 0, `recoverCalls=${recoverCalls}`);
    check("tick was NOT called",
      tickCalls === 0, `tickCalls=${tickCalls}`);
    check("ticks counter is 0", summary.ticks === 0);
    check("recovered counter is 0", summary.recovered === 0);
  }

  process.stdout.write("phase 20 — preflight that throws becomes fatal_error:\n");
  {
    const { runDeliveryWorkerLoop } = runtimeMod;
    let recoverCalls = 0;
    let tickCalls = 0;
    const summary = await runDeliveryWorkerLoop(
      { maxTicks: 5, recovery: { staleAfterSeconds: 600 } },
      {
        preflight: () => { throw new Error("preflight boom"); },
        tick: async () => { tickCalls++; return { status: "nothing_to_do" }; },
        recover: async () => { recoverCalls++; return []; },
      },
    );
    check("stopReason is fatal_error",
      summary.stopReason === "fatal_error");
    check("fatalError mentions preflight",
      typeof summary.fatalError === "string" && summary.fatalError.includes("preflight boom"));
    check("recover NOT called", recoverCalls === 0);
    check("tick NOT called", tickCalls === 0);
  }

  // ── 21. 2xx without canonical id → transport_error ─────────────────
  process.stdout.write("phase 21 — 2xx without canonical id is strict:\n");
  freshRig();
  rig.nextSendResponse = { status: 200, body: { threadId: "thread-only" } };
  {
    let err = null;
    try {
      await sendGmailPlainText({
        refreshToken: "stub-refresh",
        email: {
          fromEmail: "from@example.test", toEmail: "lin@example.test",
          subject: "x", paragraphs: [{ text: "x" }],
          messageIdSeed: "no-id", date: new Date(0),
        },
      });
    } catch (caught) { err = caught; }
    check("2xx without id throws GmailTransportError",
      err instanceof GmailTransportError);
    check("reason is transport_error", err?.reason === "transport_error");
    check("error mentions canonical message id",
      typeof err?.message === "string" && /message id/i.test(err.message));
  }
} finally {
  stub.close();
  await wait(50);
  await cleanup();
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
} else {
  process.stdout.write("\nall delivery-worker transport checks passed\n");
  process.exit(0);
}
