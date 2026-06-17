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

async function loadTransport() {
  const src = await readFile(
    join(projectRoot, "lib/server/delivery-worker/gmail-transport.server.ts"),
    "utf8",
  );
  const cleaned = src.replace(/^import "server-only";\n/m, "");
  const compiled = ts.transpileModule(cleaned, {
    fileName: "gmail-transport.server.ts",
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const tempRoot = join(projectRoot, ".next", "test-delivery-worker");
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, "run-"));
  const out = join(tempDir, "gmail-transport.cjs");
  await writeFile(out, compiled);
  return {
    mod: require(out),
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

const { mod, cleanup } = await loadTransport();
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

  // ── 8. 2xx without canonical id → transport_error ──────────────────
  process.stdout.write("phase 8 — 2xx without canonical id is strict:\n");
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
