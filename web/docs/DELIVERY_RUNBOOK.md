# Keepsake — delivery lifecycle runbook

This is the local-ops runbook for the email delivery loop. It covers
the path Workspace → enqueue → worker → Gmail → webhook → History,
and the levers needed to drive each step by hand without standing up
a real Gmail push subscription.

The runbook is the source of truth for "how do I exercise the
end-to-end delivery flow on my laptop" and "delivery looks stuck —
which knob do I turn first". For the contracts, see
[CURRENT_ARCHITECTURE.md](./CURRENT_ARCHITECTURE.md); for the schema
view, see [DB_SCHEMA.md](./DB_SCHEMA.md); for what's done and what's
intentionally not yet built, see
[DEVELOPMENT_PROGRESS.md](./DEVELOPMENT_PROGRESS.md).

---

## 1. Environment variables

Set these in `.env.local` (or whatever loader your editor uses). The
test harnesses each set their own per-run, but for hand-driving the
lifecycle you want all of them in one file.

### 1.1 App / session

| Var | Purpose | Required for |
|---|---|---|
| `APP_SESSION_SIGNING_SECRET` | HMAC-SHA256 secret used by `lib/server/auth/session.server.ts` to sign/verify the `keepsake_session` cookie. **≥32 chars.** | Anything that needs `requireSessionUserOrRedirect()` — i.e. `/`, `/people`, `/workspace`, `/history`, `/profile`, and minting a dev session. |
| `ENABLE_DEV_SESSION_ROUTES=1` | Unlocks `POST /api/auth/dev-session/{start,clear}` so you can mint a session without a real Google sign-in. **Unset in production.** | Local exercise of the lifecycle without standing up Google OAuth. |
| `DEV_OWNER_ID`, `DEV_OWNER_EMAIL`, `DEV_OWNER_NAME` | The owner identity the dev-session route mints into the cookie. `DEV_OWNER_ID` MUST be a UUID. | Local-only. Routes / seams also accept these as a cookie-first fallback via `currentUserOrThrow()`. |

### 1.2 Database

| Var | Purpose | Required for |
|---|---|---|
| `KEEPSAKE_DATA_SOURCE=db` | Flip every seam (people, drafts, deliveries, history, webhook) from mock to Postgres. Default is `mock`. | The whole lifecycle. Without it `pnpm worker:run` is a no-op and the webhook returns `delivery_not_found` on every event. |
| `DATABASE_URL` | Request-path pool DSN. Must connect as a `NOBYPASSRLS` role; RLS enforces `app.user_id`. | Pages, API routes, the seed fixtures, History. |
| `KEEPSAKE_WORKER_DATABASE_URL` | Worker-path pool DSN. Must connect as a `BYPASSRLS` role so the worker can scan the queue and the webhook can find rows by `provider_message_id` without an owner id. Falls back to `DATABASE_URL` when unset — fine for local dev with a superuser DSN. | `pnpm worker:run`, `POST /api/webhooks/deliveries` in DB mode. |
| `DEV_ENCRYPTION_KEY_BASE64` | AES-256-GCM key (32 raw bytes, base64-encoded). Encrypts `recipient_name`, `recipient_email`, `occasion_label`, refresh tokens, etc. **Must be the same value across processes that read each other's writes.** | Seeding fixtures, the worker (decrypts refresh tokens + recipient before sending), and reading History. |

### 1.3 Gmail OAuth + send

| Var | Purpose | Required for |
|---|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth client used by both the Gmail connect flow (`/api/oauth/gmail/start`) and the worker's refresh→access exchange. | Connecting a Gmail account and `pnpm worker:run` actually calling Gmail. |
| `GOOGLE_REDIRECT_URI` | Must match the redirect registered in Google Cloud Console. | Gmail OAuth connect. |
| `OAUTH_STATE_SIGNING_SECRET` | HMAC secret for the Gmail OAuth state cookie. **≥32 chars.** | Gmail OAuth connect (start + callback). |
| `GOOGLE_TOKEN_ENDPOINT` | Overrides the token-exchange URL. Default = Google's real endpoint. | Pointing the worker at a local Gmail stub during testing. |
| `KEEPSAKE_GMAIL_API_BASE` | Overrides the Gmail send endpoint base. Default = `https://gmail.googleapis.com`. | Same — local Gmail stub. |

### 1.4 Webhook (P7-A)

| Var | Purpose | Required for |
|---|---|---|
| `DELIVERY_WEBHOOK_SECRET` | Shared secret presented by the provider in the `x-keepsake-webhook-secret` header. Route returns 501 when unset, 401 when mismatched. | `POST /api/webhooks/deliveries`. |

---

## 2. The lifecycle, step by step

The whole loop has seven manual steps locally. Each section below
assumes the previous one succeeded.

### Step 1 — seed dev fixtures

```bash
# Reads lib/mock.ts → INSERTs the same people, occasions, and 4 deliveries
# (one of which carries status='failed', see P7-B).
pnpm db:seed:dev
```

What you get afterward:

- 1 dev owner (`DEV_OWNER_ID` / `_EMAIL` / `_NAME`)
- 1 placeholder Gmail account row (not yet connected — empty refresh token)
- The fixture people + occasions
- 4 `deliveries` rows, with `provider_message_id` set to `dev-fixture:<id>`
  and `sent_at` already populated. These are *seed history*, not rows
  the worker will drain.

### Step 2 — start the app

```bash
pnpm dev      # starts Next.js on :3000 (default)
```

If the env guard refuses, run `pnpm env:init` once to scaffold a
`.env.local`, then fill in the secrets that matter to you (at minimum
`APP_SESSION_SIGNING_SECRET`, `DEV_OWNER_*`, `DATABASE_URL`,
`DEV_ENCRYPTION_KEY_BASE64`, `KEEPSAKE_DATA_SOURCE=db`).

### Step 3 — sign in + connect Gmail

Two ways:

1. **Google sign-in** — visit `http://localhost:3000/signin` and use
   the Google CTA. Requires `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`
   + a redirect registered for `localhost`.
2. **Dev session** — with `ENABLE_DEV_SESSION_ROUTES=1`, the `/signin`
   page also shows a *Continue as dev owner* form that posts to
   `/api/auth/dev-session/start?returnTo=/`. This mints a real
   `keepsake_session` cookie tied to `DEV_OWNER_*` without going
   through Google.

Then on `/profile`, click *Connect Gmail* — that's the OAuth flow at
`/api/oauth/gmail/start`. The encrypted refresh token lands in
`gmail_accounts` with `status='connected'`.

### Step 4 — queue an email from Workspace

Open `/workspace?person=<personId>`, click the recipient email field,
fill in an address you control, choose a tone, click *Send email*.
This posts to `POST /api/deliveries`:

- 202 + `QueuedDelivery` on success: a new `deliveries` row with
  `status='queued'`, `sent_at=NULL`, `provider_message_id=NULL`.
- 409 `sender_not_connected` if step 3 isn't done.
- 409 `sender_expired` if Gmail's revoke-side path tripped the
  refresh token (see [troubleshooting](#3-troubleshooting)).
- 409 `no_draft` if there's no canonical draft yet — go back to the
  composer, let `PATCH /api/drafts` autosave, then retry.

### Step 5 — drain the queue

```bash
pnpm worker:run            # one bounded loop, then exits
```

The worker runs `runWorkerLoop({ maxTicks, recovery, stopOnFailure })`
in `lib/server/delivery-worker/index.server.ts`. On a healthy queue
each queued email goes through CLAIM (`status='sending'`) → HYDRATE
(decrypt + Gmail token refresh) → SEND (Gmail API) → FINALISE
(`status='sent'`, `provider_message_id=<Gmail messageId>`). The
worker prints a JSON summary per tick; non-zero `failed` or a
non-empty `missing` env list means stop and read
[troubleshooting](#3-troubleshooting).

The worker NEVER advances rows past `sent` — `delivered`, `opened`,
and (terminal-after-send) `failed` only land via the webhook.

### Step 6 — simulate provider webhook events

The worker stamped `provider_message_id` on each row in step 5. Use
that value as the webhook identity. The route is provider-agnostic;
`provider:"mock"` is fine for local exercise:

```bash
# 1. Look up the row in psql (or wherever) to find the
#    provider_message_id the worker just wrote:
psql "$DATABASE_URL" -c \
  "SELECT id, status, provider_message_id FROM deliveries
   WHERE status='sent' ORDER BY sent_at DESC LIMIT 5;"

# 2. Send a delivered event:
curl -sS -X POST http://localhost:3000/api/webhooks/deliveries \
  -H "content-type: application/json" \
  -H "x-keepsake-webhook-secret: $DELIVERY_WEBHOOK_SECRET" \
  -d '{
    "provider": "mock",
    "providerMessageId": "<paste from step 1>",
    "event": "delivered",
    "occurredAtISO": "2026-06-19T12:00:00Z",
    "providerStatus": "delivered-by-provider"
  }'
# → 200 { "ok": true, "deliveryId": "...", "status": "delivered", "updated": true }

# 3. Then an opened event:
curl -sS -X POST http://localhost:3000/api/webhooks/deliveries \
  -H "content-type: application/json" \
  -H "x-keepsake-webhook-secret: $DELIVERY_WEBHOOK_SECRET" \
  -d '{
    "provider": "mock",
    "providerMessageId": "<same id>",
    "event": "opened",
    "occurredAtISO": "2026-06-19T13:00:00Z"
  }'
# → 200 status="opened"; delivered_at preserved, opened_at stamped.

# 4. Or simulate a bounce instead:
curl -sS -X POST http://localhost:3000/api/webhooks/deliveries \
  -H "content-type: application/json" \
  -H "x-keepsake-webhook-secret: $DELIVERY_WEBHOOK_SECRET" \
  -d '{
    "provider": "mock",
    "providerMessageId": "<id from a row still at status=sent>",
    "event": "failed",
    "failureReason": "mailbox unavailable"
  }'
# → 200 status="failed". failure_reason persisted; delivered_at/opened_at NOT stamped.
```

Transition rules (enforced by `DeliveryRepository.markStatus`):

- Forward order is `queued < sending < sent < delivered < opened`.
- `failed` is a side-branch terminal — writable only from
  `{queued, sending, sent}`. A `failed` event on an already-`opened`
  row is a no-op (200 + `updated:false`); `failure_reason` is NOT
  recorded.
- Regression events (e.g. `delivered` after `opened`) freeze every
  field, not just `status`. The webhook is idempotent under provider
  retries.

### Step 7 — refresh /history and read the status

Open `http://localhost:3000/history`. Each delivery row carries a
`data-delivery-status="<value>"` attribute and one of three tone
classes:

| Status | Tone class | Icon | Colour |
|---|---|---|---|
| `queued`, `sending`, `sent` | `ks-delivery-status--neutral` | `i-clock` / `i-send` | gray / blue |
| `delivered`, `opened` | `ks-delivery-status--success` | `i-check-plain` | `#3F9E78` green |
| `failed` | `ks-delivery-status--warn` | `i-alert` | `#C2381C` red |

A failed bounce never borrows the success green. The History page
does NOT poll — refresh after each webhook event.

---

## 3. Troubleshooting

The questions below are ordered by *where the symptom shows up*. If
you don't know which step you're stuck on, read step 2 first
(`pnpm dev` env guard) — it catches most env misses.

### 3.1 Sign in / page loads

| Symptom | Likely cause | Fix |
|---|---|---|
| Every page redirects to `/signin` | No valid `keepsake_session` cookie. P6-C made `/`, `/people`, `/workspace`, `/history`, `/profile` cookie-only — `DEV_OWNER_*` is no longer enough on its own. | Visit `/signin` and use either the Google CTA or the dev CTA (the latter needs `ENABLE_DEV_SESSION_ROUTES=1`). |
| `/signin` itself 500s, and `/api/session` returns `Auth is misconfigured` | `APP_SESSION_SIGNING_SECRET` is unset or <32 chars. | Set a real 32+ char secret and restart `pnpm dev`. |
| `/api/session` returns 401 `Unauthenticated` for a brand-new tab | Expected when there is no cookie AND `DEV_OWNER_*` is unset. Routes use cookie-first + env fallback; with neither, you get 401. | Fix the cookie path (sign in) or set `DEV_OWNER_*` if you want the route/seam layer to work without signing in. |

### 3.2 Workspace → POST /api/deliveries (enqueue)

| Symptom | Likely cause | Fix |
|---|---|---|
| 409 `sender_not_connected` | No `gmail_accounts` row for this owner, or `is_primary=false`. | `/profile` → Connect Gmail. |
| 409 `sender_expired` | `gmail_accounts.status='expired'`. Set when a previous worker tick got `invalid_grant` from Gmail's token endpoint. | `/profile` → Reconnect Gmail. |
| 409 `no_draft` | The owner hasn't composed for this person/occasion yet (no canonical `message_drafts` row). | Compose in Workspace, let autosave land, retry. |
| 400 `invalid_request` | Missing `recipientEmail` for `channel:"email"` or malformed UUIDs. | Check the POST body shape. |

### 3.3 `pnpm worker:run`

| Symptom | Likely cause | Fix |
|---|---|---|
| `stopReason: "misconfigured"`, non-empty `missing: [...]` | Worker can't run — required env (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `KEEPSAKE_DATA_SOURCE=db`, …) is unset. The worker refuses to touch the queue when misconfigured. | Set every var in the `missing` list and re-run. |
| `stopReason: "nothing_to_do"`, `sent: 0` | Either the queue is empty or every queued row has `scheduled_for` in the future. | Confirm there's a `status='queued'` row with `scheduled_for IS NULL OR <= now()`. |
| `failed: 1, reason: "token_invalid"` | Gmail refused the refresh token. The worker also flips `gmail_accounts.status='expired'`. | `/profile` → Reconnect Gmail. |
| Delivery stuck in `sending` | A previous worker tick crashed between CLAIM and FINALISE. The row's `updated_at` is older than your stale threshold. | Re-run with stuck-row recovery via the env knob `scripts/run-delivery-worker.mjs` reads — default is 600s. To recover anything older than e.g. 300s: `KEEPSAKE_WORKER_RECOVERY_AFTER=300 pnpm worker:run` Setting `KEEPSAKE_WORKER_RECOVERY_AFTER=0` disables the recovery pass entirely (`pnpm worker:run` just drains the queue). **Read the duplicate-send caveat in [CURRENT_ARCHITECTURE.md §Stuck-sending recovery](./CURRENT_ARCHITECTURE.md) before lowering the threshold under the default — a row recovered too quickly may have already been accepted by Gmail.** |

### 3.4 `POST /api/webhooks/deliveries`

| Symptom | Likely cause | Fix |
|---|---|---|
| 501 `not_configured` | `DELIVERY_WEBHOOK_SECRET` env unset. | Set it and restart `pnpm dev`. |
| 401 `unauthorized` | Header missing or mismatched. | Check `x-keepsake-webhook-secret` value in your curl. |
| 400 `invalid_json` | Body isn't JSON. | Check your `-d` payload. |
| 400 `invalid_event` (+ `detail`) | Shape miss. `detail` names the field: `provider`, `event`, `providerMessageId`, `occurredAtISO`, or `body`. | Match the documented contract above. |
| 404 `delivery_not_found` | No `deliveries` row has that `provider_message_id`. | Confirm the worker actually finished step 5 (status=sent + non-null `provider_message_id`). In mock mode you'll always get 404 — flip `KEEPSAKE_DATA_SOURCE=db`. |

### 3.5 History didn't change

When you refresh `/history` and the row still shows the old status,
check in this order:

1. **`provider_message_id`** — the row you targeted in step 6 must
   actually have that value. Re-query `SELECT id, status,
   provider_message_id FROM deliveries WHERE id = '<delivery id>';`
   to confirm.
2. **`DELIVERY_WEBHOOK_SECRET`** — set in both your shell (for
   `curl`) and the dev server's env. A 401 on the webhook means the
   row never moved.
3. **`KEEPSAKE_DATA_SOURCE=db`** — without this the webhook returns
   `delivery_not_found` (mock mode has no rows). The History page in
   DB mode also requires this env, of course.
4. **Page refresh** — there's no live polling, no SSE. Hit reload.
5. **Row is already terminal** — `failed` is sticky. `opened` won't
   accept a later `delivered`. The webhook responds 200 with
   `updated:false` — that's expected, not a bug.

---

## 4. Non-goals

This runbook deliberately stops where the current slice stops. The
following are explicit non-goals; do NOT add them just because the
runbook covers a partial loop:

- **No Gmail push subscription yet.** Step 6 uses `provider:"mock"`
  events posted by hand. Wiring Gmail's pubsub topic is its own
  slice — the route is already provider-agnostic, so the work is on
  the subscription side, not the route side.
- **No cron / daemon yet.** `pnpm worker:run` is a single bounded
  loop. Operators / cron / a scheduler will wrap it later; the
  worker itself stays a pure function.
- **No retry/backoff/dead-letter yet.** A `failed` row is terminal.
  There is no retry queue and no automatic re-attempt window. If you
  want to re-attempt manually, requeue the row directly in SQL — and
  understand you may double-send.
- **No live polling / SSE yet.** History reads `deliveries.status`
  on each page navigation. There is no WebSocket, no Server-Sent
  Events, no client-side timer. Refresh the page.
