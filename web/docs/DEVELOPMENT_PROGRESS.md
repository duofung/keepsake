# Keepsake Development Progress

This document is the working project board for Keepsake. It tracks what is
already stable, what is active, what is queued, and how Codex/CC work should be
split.

## Operating Model

| Role | Responsibility | Output |
|---|---|---|
| PM / architect Codex | Owns the roadmap, splits work into safe slices, reviews implementation results, decides checkpoint timing. | Task prompts, acceptance criteria, final checkpoint summary. |
| Codex implementation agent | Implements one bounded task at a time. Must keep scope tight and run the required tests. | Code/docs/tests + validation log + clean status or clear blockers. |
| CC | Read-only reviewer. Checks invariants, risks, missing tests, and whether the task is safe to checkpoint. | Blockers, non-blocking notes, checkpoint recommendation. |
| User | Chooses direction, forwards CC prompts, confirms product priorities. | Go/no-go and product feedback. |

Rules:

- One task should touch one vertical whenever possible.
- Every implementation task needs explicit out-of-scope boundaries.
- Every checkpoint needs `pnpm test`, `pnpm build`, and any relevant `pnpm test:db:*`.
- CC gets a read-only prompt after an implementation candidate is complete.
- A task is not done until blockers are fixed or explicitly accepted.

## Current Status

| Workstream | Status | What Is Stable | Remaining Work |
|---|---|---|---|
| App shell + core UI | Stable | Full-screen desktop shell, Home, People, Workspace, History, Profile, smoke tests. | Mobile pass, deeper visual polish, interaction polish. |
| Domain model | Stable | `domain.ts`, presentation mapping, mock data, API contracts. | Add fields only when a real product flow needs them. |
| Mock seams | Stable | People payload, draft context, draft service, delivery history dispatchers default to mock. | Delete mock fallback only after DB mode is default and production-ready. |
| DB schema/RLS | Stable | Postgres schema, catalog seed, local dev fixtures, RLS, transaction helper. | Future migrations for real auth/session, reminders, send queue details. |
| Crypto | Stable | AES-256-GCM envelope helper, AAD conventions, tests. | KMS/DEK wrapping hardening for production. |
| People data | Stable read path | DB-backed people payload and repository reads. | People CRUD UI/API, imports, merge/archive semantics. |
| Draft generation/persistence | Stable mock + opt-in LLM seam + DB persistence + user-edit versioning | DB-backed draft context/service, draft repository, latest/version reads. `KEEPSAKE_DRAFT_SOURCE=openai` plugs an OpenAI-compatible provider in behind `getDraftGenerator()`; default stays mock. `PATCH /api/drafts` persists Workspace subject + card edits as new canonical versions with `prompt_input_hash = NULL`. | Paragraph / tone editing, prompt evaluation harness, A/B, retries on `unavailable`, prompt provenance beyond `model_provider` / `model_version`. |
| Delivery history | Stable read path | DB-backed history page and deliveries read repository. | Send/enqueue/webhook/worker write paths. |
| Auth/current user | Cookie-backed session foundation + Google sign-in transport + `/signin` page + page-level redirects + dev fallback | `keepsake_session` HMAC-signed cookie is the primary identity source. Product pages call `requireSessionUserOrRedirect()` (cookie-only, redirects unauth to `/signin?returnTo=…`). Routes / API handlers / server seams still use `currentUserOrThrow()` (cookie-first with `DEV_OWNER_*` env fallback). `/api/auth/google/{start,callback}` runs the real Google identity flow. `/api/auth/dev-session/{start,clear}` are gated dev bootstrap; start now 303s when given `?returnTo=`. `/api/session` shape unchanged. | UI logout, retiring the `DEV_OWNER_*` env fallback from the cookie-first seam. |
| Gmail OAuth | Stable start + callback | Full HMAC state cookie, native-fetch token exchange, account upsert on success, cookie cleared on every response. | Token refresh + markExpired on send failure, Google revoke on disconnect. |
| Sending account UI | Connect/Disconnect wired | Profile shows Not connected / Connected / Expired with Connect / Reconnect / Disconnect CTAs that drive `/api/oauth/gmail/start` and `POST /api/gmail/disconnect`. Idempotent + cross-owner safe. | Auto-repair on expired refresh, Google revoke on disconnect, multi-account support. |
| Email send | Stable end-to-end (enqueue + bounded loop runtime + Gmail send + stale-recovery) | `POST /api/deliveries` queues a row with `recipientEmail` encrypted; `pnpm worker:run` drives `runWorkerLoop({ maxTicks, recovery, stopOnFailure })`, which optionally requeues stuck `'sending'` rows then drains the queue one tick at a time via `processNextQueuedEmail()`. SELECT FOR UPDATE SKIP LOCKED + `sending` state prevents double-send in healthy operation; stale recovery is operator-gated with explicit duplicate-send risk. | Webhook ingest (delivered/opened), retry/backoff queue, cron/daemon, concurrent worker pool, post-channel worker, `Person.email` / `person_contacts` model. |
| Command Channel Platform | Planned | Product/architecture direction: WhatsApp, Telegram, Slack, and similar tools become natural-language command inputs and notification surfaces; Web remains the execution workspace. | Standard command event/response contract, channel identity/linking, adapters, webhook routes, first relationship follow-up intents. |
| Reminders/scheduler | Not started | Occasion data exists. | Reminder jobs, notification strategy, due-date windows. |
| Deployment/ops | Not started | Local env guard/init and Docker DB tests. | Production env, CI, hosting, logs, secrets, migrations. |

## Immediate Execution Queue

### P0. Hydrate `CurrentUser.sendingAccount` From DB

Status: done. Guarded by `pnpm test:db:current-user`.

Goal: when `KEEPSAKE_DATA_SOURCE=db`, `currentUserOrThrow()` should use
`GmailAccountRepository.getPrimary(ownerId)` to populate
`CurrentUser.sendingAccount`.

Owner: Codex implementation agent.

In scope:

- Keep default mock/dev behavior returning `sendingAccount: null` unless DB mode
  has a connected/expired Gmail account.
- Add or update DB tests proving connected and expired account states map into
  `/api/session`, Profile, and Workspace-visible user shape.
- Keep route/page contracts unchanged.

Out of scope:

- No Google SDK.
- No OAuth token exchange.
- No send/enqueue.
- No Profile connect button behavior beyond existing display.

Required validation:

- `pnpm test`
- `pnpm build`
- Relevant DB test, likely new or extended session/auth DB route test.
- `git diff --check`

CC review focus:

- DB-mode auth seam owns the lookup.
- No UI/page imports repository directly.
- No token plaintext leaves repository write boundary.
- Mock/default mode remains unchanged.

### P1. Real Gmail OAuth Start/Callback

Goal: replace OAuth stubs with real start/callback flow while keeping routes
thin.

Owner: Codex implementation agent after P0.

Current slicing:

- `P1-A` start route: Google redirect + state cookie, no token exchange.
- `P1-B` callback: state validation + code exchange + account upsert.

Status:

- `P1-A` done. Guarded by `pnpm test:oauth`.
- `P1-B` done. Guarded by `pnpm test:oauth` (validation paths) and
  `pnpm test:db:gmail-callback` (full token-exchange + DB write + replay).

In scope (delivered):

- HMAC-signed state cookie (`OAUTH_STATE_SIGNING_SECRET`, ≥32 chars).
- Callback verifies cookie signature, 10-minute TTL, owner match, and
  state-vs-cookie match before any network call.
- Token exchange via native `fetch` to `GOOGLE_TOKEN_ENDPOINT` (defaults to
  `https://oauth2.googleapis.com/token`; tests override).
- Account email extracted from the id_token claim (`openid email` scope) —
  the smallest officially-supported way to learn the authorizing user's
  verified email. No extra Gmail capability.
- Persists encrypted refresh-token metadata through
  `GmailAccountRepository.upsertPrimary`; transaction opens only after token
  exchange returns so network calls stay outside the DB transaction.
- Plaintext refresh token only crosses the repository input boundary; never
  logged.
- State cookie cleared on every callback response (success or failure).

Out of scope:

- No email sending.
- No queue.
- No draft-generation changes.
- No CSRF protection beyond HMAC state cookie. Server-side single-use nonces
  are not introduced (Google rejects authorization-code reuse, providing the
  defense the protocol relies on).

### P2. Profile Connect/Disconnect Flow

Goal: make Profile accurately show Gmail account state and initiate connect or
disconnect.

Owner: Codex implementation agent.

Status: done. Guarded by `pnpm test:profile` (mock-mode Connect CTA) and
`pnpm test:db:current-user` (connected/expired/empty states + disconnect
flow + cross-owner safety + idempotency).

In scope (delivered):

- Profile "Sending email" row renders `Not connected` / `Connected` / `Expired`
  from `currentUserOrThrow().sendingAccount`.
- Connect / Reconnect CTAs link to existing `/api/oauth/gmail/start?returnTo=/profile`.
- Disconnect is a thin `POST /api/gmail/disconnect` route → service seam
  `lib/server/gmail-account/disconnect.server.ts` → `GmailAccountRepository.disconnect`.
- Disconnect is idempotent (no-op on missing row, mock-mode short-circuit) and
  always 303s to `/profile`.
- Cross-owner safety enforced by the existing repo `WHERE owner_id = $1`
  filter + RLS.

Out of scope:

- No message sending.
- No token refresh worker.
- No Google revoke API call (the refresh token is left in Google's records
  until a separate cleanup pass).
- No client-side state management — disconnect uses a plain form POST.

### P3. Send Boundary Contract

Status: done. Guarded by `pnpm test:deliveries` and `pnpm test:db:deliveries-route`.

Goal: define the server-side contract for turning a draft into a queued/sent
delivery without implementing Gmail send yet.

Shipped:

- `POST /api/deliveries` thin route that parses JSON, runs
  `currentUserIdOrThrow()` for the auth 401/500 contract, and delegates to the
  send-boundary seam.
- `lib/server/delivery-send/{index,mock,db}.server.ts` dispatcher matching the
  draft-service pattern: env switch in `index`, shared request validation in
  `mock`, full DB path in `db`.
- DB path: validates the request, resolves person/occasion ownership through
  the shared `resolveDbDraftContextInTx` helper, looks up the latest draft, and
  on success calls `DeliveryRepository.enqueue` inside a single RLS-scoped
  transaction. Email channel requires the primary Gmail account to be
  `connected` (409 `sender_not_connected` / `sender_expired`); post channel
  bypasses the sender precondition.
- `DeliveryRepository.enqueue` real implementation inserts an encrypted row
  with `status='queued'` and `sent_at=NULL`, returning a `QueuedDelivery` shape
  (deliberately distinct from the history-shaped `Delivery` type so we do not
  force-fit a queued row into a sent row).
- Mock dispatcher returns a synthetic `QueuedDelivery` so the default smoke can
  run without Docker.

Returns 202 with "queued/accepted" semantics — not fake "sent". No Gmail API
call, no worker, no status mutation.

Out of scope (next slices):

- No Gmail API send call until the queue and delivery model are reviewed.
- No worker that drains queued rows.
- No webhook or status update.

### P3.1 Workspace Queue Wiring

Status: done. Guarded by `pnpm test:workspace` (regression copy guards) and
the existing `pnpm test:deliveries` route smokes.

Goal: connect the Workspace `Send email` / `Mail as card` buttons to the
real `POST /api/deliveries` queue boundary instead of the local fake-toast
shortcut.

Shipped:

- `app/workspace/WorkspaceClient.tsx` now POSTs to `/api/deliveries` with
  `{ personId, occasionId, channel }`, disables both send buttons during the
  request (avoiding double-submit), and toasts a queue-honest success ("Queued
  email for Lin." / "Queued printed card for Lin.") before navigating Home.
- Server-side errors map to user-facing copy without inventing new fields:
  401 → re-sign-in prompt; 404 `person_not_found` / `occasion_not_found` →
  go-back hint; 409 `sender_not_connected` → Profile Connect prompt; 409
  `sender_expired` → Profile Reconnect prompt; 409 `no_draft` → regenerate
  prompt; other 4xx/5xx → generic "Could not queue this delivery." Error
  toasts use `role="alert"` and the `i-alert` icon, success uses
  `role="status"` and `i-check`.
- Success copy is deliberately neutral ("Queued …") and never says "sent",
  because:
  1. the Gmail worker is not wired (the row is queued, not sent), and
  2. Workspace's compose view holds client-local subject/card edits that are
     not persisted into the queued draft — claiming "sent" would lie about
     either condition.

Out of scope (still future slices):

- No Gmail API send call. Queued rows wait for a worker that does not exist
  yet.
- No worker / webhook / `markStatus` wiring.
- No persistence of client-local Workspace edits — superseded by P4-B,
  which now PATCHes subject + card edits into a new canonical draft version
  before send.

### P4-B. Workspace Draft Edit Persistence

Status: done. Guarded by `pnpm test:drafts` (PATCH coverage in mock,
including no-op suppression, null-card path, and latest/versions
reflection) and `pnpm test:db:drafts-route` (same surface against DB
under RLS). Workspace SSR check in `pnpm test:workspace` guards the
save-status affordance.

Goal: close the "I changed the subject / toggled the card but the queued
delivery used the old draft" gap from P3.1, without expanding draft
authorship beyond subject + card.

Shipped:

- `PATCH /api/drafts` with body `{ draftId, subject, attachedCard }`.
  Route stays thin: parse → delegate → JSON. Mock and DB dispatchers live
  behind the same seam.
- Server is authoritative: the route accepts only `draftId` + the two
  editable fields. `personId`, `occasionId`, tone, paragraphs,
  `quickActions`, `assistantNote` are inherited from the base draft and
  cannot be overridden from the client.
- A successful edit inserts a NEW `message_drafts` row (DB) / records a
  new version in the mock store. No in-place updates of the base row,
  ever. Versions list and latest reads reflect the edit.
- Version inflation is suppressed: if `(subject, attachedCard)` deep-equal
  the base, the route returns the base draft without inserting.
- Edited rows persist with `prompt_input_hash = NULL` so
  `findByPromptHash` never returns user-edited content as a generator
  cache hit. `MessageDraftSaveInput.promptHash` typed as `string | null`
  to enforce this.
- New `DraftRepository.getById(ownerId, draftId, tx?)` for owner-scoped
  point lookups. Cross-owner and unknown ids both return `null`; the
  service maps both to 404 without distinguishing.
- Mock path keeps a process-local in-memory store
  (`mock-store.server.ts`) so POST → PATCH → GET latest → GET versions
  all round-trip within the same Node process.
- Workspace autosaves subject (700ms debounce) and card toggle
  (immediate). `queueDelivery` awaits a `flushDraftEdits()` call before
  POSTing to `/api/deliveries`; a save failure aborts the send and
  surfaces an error toast.
- Workspace renders a small save-status affordance ("Edits save
  automatically" / "Saving…" / "Saved" / "Could not save") that is
  separate from the send-queue toast. `role="status"` + `aria-live`.

Out of scope (still future slices):

- No paragraph / tone editing. The body of the draft remains generator
  output.
- No Gmail send worker, webhook, or `markStatus`.
- No cross-process mock persistence. The mock store is intentionally
  per-process; production-shaped flows use DB mode.
- No optimistic UI for the edited draft beyond the local subject/card
  state already shown.

### P4-A. Real Draft Generator Runtime

Status: done. Guarded by `pnpm test:draft-generator` (mock default, missing
API key, stubbed-OK, malformed-response) and the existing `pnpm test:drafts`
mock smoke.

Goal: turn the `draft-generator` seam from "mock-only" into a real
mock/provider-swappable runtime, without touching the `/api/drafts` route
contract or the `MessageDraft` shape the UI renders.

Shipped:

- `lib/server/draft-generator/index.server.ts` — `getDraftGenerator()`
  dispatcher driven by `KEEPSAKE_DRAFT_SOURCE` (`mock` default, `openai`
  opt-in). Independent of `KEEPSAKE_DATA_SOURCE`; all four combinations are
  valid. Caches the constructed generator per process.
- `lib/server/draft-generator/openai.server.ts` — OpenAI-compatible chat
  completions adapter. Reads `KEEPSAKE_DRAFT_API_KEY` (required),
  `KEEPSAKE_DRAFT_API_BASE` (defaults to `https://api.openai.com/v1`), and
  `KEEPSAKE_DRAFT_MODEL` (defaults to `gpt-4o-mini`). System prompt locks
  output to a constrained JSON shape with a tone from the existing union;
  any provider that speaks `POST /v1/chat/completions` (OpenAI, Anthropic
  gateways, vLLM, Ollama, local stubs) drops in.
- `DraftGenerator` interface gained `modelProvider` / `modelVersion`. The
  prompt-cache hash (`promptInputHash`) now folds these in, so swapping
  providers invalidates previously cached drafts automatically.
- `tone`, `subject`, `paragraphs`, `assistantNote` come from the LLM.
  `attachedCard` and `quickActions` stay on the deterministic mapping from
  `mock.server.ts` (exported as `deterministicRecipe`) — we don't trust the
  model to round-trip presentation hints yet.
- `DraftGeneratorError("misconfigured" | "unavailable" | "malformed_response", …)`
  is caught by `draft-service/{mock,db}.server.ts` and mapped through
  `generator-errors.server.ts` to the existing route shape
  `{ error: "Draft generator is misconfigured" | "… unavailable" | "… returned an unusable response" }` at status 500.
  Provider URLs, status codes, and stack traces never reach the client.
- `.env.example` documents the new env switches and explicitly says missing
  `KEEPSAKE_DRAFT_API_KEY` does NOT silently fall back to mock.

Out of scope (next slices):

- No prompt persistence, evaluation harness, A/B, or model tuning.
- No UI redesign — the route response is still `MessageDraft`, and Workspace
  renders it the same way.
- No history of prompt/response provenance beyond what `message_drafts`
  already stores (`model_provider`, `model_version`, `prompt_input_hash`).
- No retries on `unavailable` — first failure surfaces as a 500. Retries
  belong in a worker tier we haven't built.
- No streaming. The route still returns a single `MessageDraft`.
- No tool-use, function-calling, multi-turn assistant memory, or culture-aware
  taboo enforcement beyond what the system prompt asks for.

### P5-preA. Send-time Recipient Email

Status: done. Guarded by `pnpm test:deliveries` (mock + recipient-email
shape validation) and `pnpm test:db:deliveries-route` (DB enqueue +
`recipient_email_enc` decryption). Workspace SSR check in
`pnpm test:workspace` guards the new `To` row input.

Goal: unblock P5 (the send worker) by giving every queued email row a
recipient address. Until now `deliveries.recipient_email_enc` was always
NULL because the enqueue path had nowhere to read a recipient address
from — `Person` carries no email and there is no `person_contacts` table.

Shipped:

- `DeliveryRequest` gains `recipientEmail?: string`. The route is
  server-authoritative: the email is validated in the delivery-send seam
  (basic email regex, ≤254 chars). Missing or malformed values for the
  email channel return 400 `invalid_request` BEFORE any DB lookup; post
  channel ignores the field.
- `enqueueDbDelivery` threads the trimmed, validated value into
  `DeliveryRepository.enqueue`, which already supported encrypting it
  into `recipient_email_enc`. The DB column is no longer NULL for new
  email rows.
- `QueuedDelivery` does NOT echo `recipientEmail` — recipient identity
  stays on the server-side queued row only. A receipt that the user
  sees should not re-state what they typed.
- Workspace `To` row gains a minimal email `<input type="email">` that
  posts the address to `/api/deliveries` at send time. Client-side
  validation catches obvious mistakes ("Add a recipient email…",
  "Enter a valid recipient email."); the server re-validates regardless.
  The address is local component state — it is NEVER persisted on the
  draft (PATCH /api/drafts is untouched) and NEVER backfilled onto
  Person.
- The product decision is explicit: recipient identity is named at
  send time, not stored as a property of the relationship. A future
  slice may add `Person.email` (or a `person_contacts` table) and have
  enqueue prefer that over the request body; this slice deliberately
  does not pick that direction.

Out of scope (still future slices):

- The send worker itself (P5). This slice only fixes the data face so
  the worker has somewhere to read the recipient address from.
- `Person.email` / `person_contacts` schema additions.
- Address book / contact picker UI in Workspace.
- Recipient name editing (still derived from `Person.name`).

### P5-A. Gmail Send Worker (one queued email per tick)

Status: done. Guarded by `pnpm test:delivery-worker` (Docker-free
transport smoke: MIME shape + token exchange + send happy/fail paths)
and `pnpm test:db:delivery-worker` (Postgres + Gmail stub integration:
seeds a queued row, drives the worker end-to-end, verifies state
transitions and no-double-send).

Goal: turn the existing queue boundary into a real send pipeline.
After P5-A, a user click in Workspace → `POST /api/deliveries`
(`queued`) → a single worker tick → `sent` row with
`provider_message_id`, with the email actually delivered to the address
encrypted into `recipient_email_enc`.

Shipped:

- Schema migration (one-time, minimal): `delivery_status` enum gains
  `'sending'` (the worker's claim state) and `'failed'` (terminal
  failure). `'sending'` is needed for double-send safety; `'failed'`
  is needed because there is no retry queue today.
- `lib/server/db/transaction.server.ts` gains `workerTransaction()` +
  `KEEPSAKE_WORKER_DATABASE_URL`. The worker connection MUST `BYPASSRLS`
  (admin URL in dev / a dedicated worker role in prod). Request-path
  `transaction()` is untouched.
- `DeliveryRepository` gains real implementations of:
  - `nextQueued(limit, tx)` — `SELECT FOR UPDATE SKIP LOCKED`,
    filtered to `status='queued' AND channel='email'`,
    `scheduled_for ASC NULLS FIRST, created_at ASC, id ASC`.
    Decrypts `recipient_name_enc` / `recipient_email_enc` /
    `recipient_address_enc` / `occasion_label_enc` using each row's
    own `owner_id`.
  - `markStatus(deliveryId, status, providerMessageId?, tx)` —
    idempotent UPDATE; `sent_at` stamped on first `sent`,
    `provider_message_id` is COALESCEd (monotonic).
  - `findByProviderMessageId(providerMessageId, tx)` — webhook
    plumbing; only returns rows with non-null `sent_at`.
- `GmailAccountRepository.getSendingCredentials(ownerId, tx)` — worker-
  only method that returns the decrypted refresh token. Documented as
  never to be returned past the send seam.
- `lib/server/delivery-worker/` — new seam matching the existing
  dispatcher pattern (`index.server.ts` env switch +
  `db.server.ts` real worker + `mock.server.ts` returns `nothing_to_do`
  + `gmail-transport.server.ts` Gmail HTTP + `types.ts` contracts).
- The DB worker uses **three transactions**: claim (FOR UPDATE SKIP
  LOCKED + flip to `sending`), hydrate (read draft + sender creds,
  no DB lock held during Gmail HTTP), finalise
  (`markStatus(sent | failed, providerMessageId?)`). Crash between
  hydrate and finalise leaves the row in `sending`; no reaper.
- `gmail-transport.server.ts` speaks native `fetch` (no Google SDK).
  `GOOGLE_TOKEN_ENDPOINT` and `KEEPSAKE_GMAIL_API_BASE` are
  env-overridable so tests point at local stubs. Errors normalise into
  `GmailTransportError` with one of `WorkerFailureReason` (`token_invalid`,
  `gmail_send_error`, `transport_error`).
- On `token_invalid` the worker also calls
  `GmailAccountRepository.markExpired(...)` so future enqueues hit the
  existing 409 `sender_expired` path instead of queueing more
  un-sendable rows.
- MIME body is plain text (RFC 2822 / 5322): CRLF newlines, UTF-8,
  `Content-Transfer-Encoding: 8bit`, conditional RFC 2047 encoded-word
  for non-ASCII subjects, deterministic `Message-ID:
  <delivery-{id}@keepsake.local>` seeded by the delivery id.
- Manual entry point: `pnpm worker:run` →
  `scripts/run-delivery-worker.mjs`. Runs one tick, prints the JSON
  result, exit 0 on `sent` / `nothing_to_do`, exit 2 on `failed`,
  exit 3 on `misconfigured`.
- **Worker-level misconfiguration never burns the queue.** The DB
  worker calls `assertGmailTransportConfig()` BEFORE the claim
  transaction; missing `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
  returns `{ status: "misconfigured", missing }` with NO DB writes —
  the queued row stays `queued`, `sent_at` stays NULL, and the Gmail
  stub is never called. Regression-pinned by phase 0 of
  `pnpm test:db:delivery-worker` and phase 7 of `pnpm test:delivery-worker`.
- **Strict 2xx-with-id contract.** A Gmail 2xx response that omits
  the canonical message id is normalised to `transport_error` rather
  than silently marking the delivery `sent` with no id to reconcile.
  `WorkerResult.sent.providerMessageId` is therefore always a
  non-empty string. Phase 8 of `pnpm test:delivery-worker` pins this.

Out of scope (still future slices):

- No cron / scheduler / daemon. `worker:run` is one-shot.
- No webhook ingest. `findByProviderMessageId` is implemented but no
  route consumes it yet.
- No retry / backoff / dead-letter / "stuck sending" reaper. Operators
  manually deal with rows stuck in `sending` (process crash between
  Gmail success and DB mark) or `failed`.
- No HTML / rich email, no attachments, no threading, no CC/BCC.
- No post-channel worker. Post-channel queued rows stay queued
  indefinitely until a future printed-card pipeline lands.
- No batch drain. One row per tick.
- No GmailAccountRepository.markExpired call when Gmail rejects the
  send itself (`gmail_send_error`) — that only fires on `token_invalid`,
  because a Gmail send refusal may be transient.

### P5-B. Worker Runtime Loop + Stuck-`sending` Recovery

Status: done. Guarded by `pnpm test:delivery-worker` (Docker-free
runtime-logic phases 9–18: empty queue, multi-row drain, misconfigured
halt, `max_ticks` cap, recovery-runs-once, `stopOnFailure`,
drain-past-failures, fatal tick / recovery error, zero-budget cap) and
`pnpm test:db:delivery-worker` (Postgres + Gmail stub phases 6–9:
multi-row loop drains 3 rows end-to-end, stale-`sending` recovery
requeues + replays a row while leaving fresh `sending` rows alone,
direct `recoverStaleSendingDeliveriesDb` no-op on a healthy queue,
loop-level misconfig refuses to claim).

Goal: take the P5-A "manual single tick" worker and make it operable
without writing a daemon — bounded loop + minimal stuck-`sending`
recovery, both honest about the duplicate-send risk.

Shipped:

- `lib/server/delivery-worker/runtime.server.ts` — pure-logic
  `runDeliveryWorkerLoop(options, deps)` with injected `tick` and
  `recover` callbacks. Stop reasons: `empty` (nothing_to_do),
  `misconfigured` (env miss), `max_ticks` (budget hit),
  `stopped_on_failure` (opt-in halt on first failed),
  `fatal_error` (tick or recovery threw). Summary surfaces `ticks`,
  `sent`, `failed`, `recovered`, plus `missing[]` /
  `fatalError` when relevant.
- `lib/server/delivery-worker/index.server.ts` —
  `runWorkerLoop(options)` wires the runtime to the production
  dispatchers (`processNextQueuedEmail` + `recoverStaleSendingDeliveries`).
- `lib/server/delivery-worker/{mock,db}.server.ts` — both gain a
  `recoverStaleSendingDeliveries…` function; mock returns `[]`,
  DB delegates to the repo.
- `DeliveryRepository.requeueStaleSending(staleAfterSeconds, tx)` —
  worker-only SQL: `UPDATE deliveries SET status='queued',
  provider_message_id=NULL, updated_at=now() WHERE status='sending'
  AND updated_at < now() - make_interval(secs => $1) RETURNING id`.
  Refuses `staleAfterSeconds <= 0` to keep "recovery" from racing
  healthy workers.
- `pnpm worker:run` now drives `runWorkerLoop` with conservative
  defaults: `maxTicks=50`, `recovery.staleAfterSeconds=600` (10 min),
  `stopOnFailure=false`. Overridable via env
  (`KEEPSAKE_WORKER_MAX_TICKS`, `KEEPSAKE_WORKER_RECOVERY_AFTER` —
  `0` disables recovery —, `KEEPSAKE_WORKER_STOP_ON_FAILURE`).
- Exit codes: **0** clean run, **2** at least one per-delivery
  `failed`, **3** misconfigured (queue untouched), **4** runtime
  crashed inside the loop.

Recovery is honest about duplicate-send risk:

- A row stuck in `'sending'` MAY have been delivered to Gmail before
  the worker crashed; we have no Gmail-side idempotency. Requeueing
  means a possible second email to the recipient.
- We chose requeue over "mark failed" because a duplicate is more
  recoverable for Keepsake's warm-message use case than a silent drop:
  the recipient sees two notes instead of zero, and Keepsake's UX is
  about consistent presence, not transactional uniqueness.
- The threshold is operator-controlled. Default 600s (10 min) is a
  practical floor — well above a healthy worker's tick budget — and
  operators can raise it for tighter control or lower it for faster
  recovery cycles, with eyes open about the duplicate risk.

Out of scope (still future slices):

- This is NOT a retry queue. There is no backoff, no max-attempts
  per row, no dead-letter classification. `failed` rows stay
  `failed`; operators decide what to do.
- No webhook ingest (delivered/opened) yet.
- No daemon / cron / scheduler configuration files. Production
  scheduling is the operator's responsibility for now;
  `runWorkerLoop` is the well-bounded primitive they can call from
  whatever they already have.
- No concurrent / multi-worker pool. `SELECT FOR UPDATE SKIP LOCKED`
  already permits concurrent workers, but we haven't tested or
  documented that path explicitly.
- No metrics / structured tracing infrastructure beyond the JSON
  summary the manual script prints.

### P6-A. Cookie-backed App Session Foundation

Status: done. Guarded by `pnpm test:auth` (sign/verify roundtrip,
tamper / expiry / missing-secret matrix on the helper, end-to-end
cookie / env-fallback / no-silent-fallback flow against the real
route layer via `dev-session/start` + `dev-session/clear`).

Goal: turn the `DEV_OWNER_*` env-read auth seam into a real
**session container** so future sign-in slices have somewhere to
land, without changing the public `{ user }` contract or shipping a
sign-in product.

Shipped:

- `lib/server/auth/session.server.ts` — stateless signed cookie
  helper. `issueSessionCookie({ ownerId, email, name, nowMs?,
  ttlSeconds?, secure? })` → `{ name: "keepsake_session", value,
  options }`. `verifySessionCookie({ cookieValue, nowMs? })`
  validates HMAC-SHA256 + expiry. Secret = `APP_SESSION_SIGNING_SECRET`
  (≥32 chars). Cookie attributes: HttpOnly, SameSite=Lax, Path=/,
  Secure on https origins. Default TTL 24h. Errors normalise to
  `SessionError("unauthenticated" | "misconfigured", …)`.
- `lib/server/auth/current-user.server.ts` — cookie-first resolver.
  Order: (1) verify `keepsake_session` cookie if present; (2)
  `DEV_OWNER_*` env fallback when NO cookie is present. A present
  but invalid cookie (bad signature / expired / malformed payload)
  raises `AuthError("unauthenticated")` and DOES NOT silently
  downgrade to env — that's the explicit transitional contract.
  Both `currentUserOrThrow()` and `currentUserIdOrThrow()` are now
  `async` (Next 15's `cookies()` is async-only); every call site
  was already in an async chain — 11 sites migrated, one-line each.
- `app/api/auth/dev-session/start/route.ts` — POST. Gated behind
  `ENABLE_DEV_SESSION_ROUTES=1` (404 when unset, no information
  leak). Bootstrap is env-ONLY (`devOwnerFromEnvOrThrow()`); the
  route deliberately does NOT consult any existing cookie, so a
  tampered cookie cannot block bootstrap and a stale-but-valid
  cookie cannot deflect identity. Mints a fresh cookie and returns
  the same `{ user }` shape as `/api/session`. `Secure` on https
  origins.
- `app/api/auth/dev-session/clear/route.ts` — POST. Same gate. 404
  when disabled, Max-Age=0 cookie when enabled.
- `currentUserIdOrThrow()` migrated to async, all 11 call sites
  awaited.
- `.env.example` documents `APP_SESSION_SIGNING_SECRET` separately
  from the existing `OAUTH_STATE_SIGNING_SECRET` so operators don't
  conflate the two.

Out of scope (still future slices):

- No real sign-in / Google identity / OAuth-driven session minting.
- No registration, password, magic-link, or email-confirmation
  flows.
- No multi-session management (one cookie, one device, one TTL).
- No DB session table — stateless cookie is enough for the
  foundation; persistent sessions land if/when we need
  revocation-on-demand.
- No middleware that gates the whole site. Each route / page still
  reaches into the auth seam directly.
- `DEV_OWNER_*` env fallback is intentionally kept so the existing
  smoke suite + local dev keep working. It will be retired in a
  later slice when real sign-in lands.

### P6-B. Google Identity Sign-In Transport

Status: done. Guarded by `pnpm test:auth` (default no-Docker route
smoke for both routes — not configured, configured-redirect, provider
denied, missing state cookie, state mismatch, data-source-not-db) and
`pnpm test:db:google-signin` (Docker PG + local Google token stub:
new email → users row created + session cookie minted +
`/api/session` reflects the persisted user; same email → SAME
`users.id` reused; new email → second `users` row).

Goal: hook the P6-A `keepsake_session` cookie up to a real Google
sign-in flow — without shipping a full sign-in product. After P6-B
the system has the transport: users can sign in with Google, the
callback mints a session, `/api/session` returns the same `{ user }`
shape it always did. No page guards, no sign-in UI, no `/signin`
page yet (that's P6-C).

Shipped:

- `lib/server/auth/google-signin.server.ts` — `startGoogleSignIn` +
  `completeGoogleSignIn`. Builds the auth URL (scope: `openid email
  profile`), signs the state cookie with `OAUTH_STATE_SIGNING_SECRET`
  (same secret as the Gmail OAuth flow), exchanges code via native
  `fetch` against `KEEPSAKE_AUTH_GOOGLE_TOKEN_ENDPOINT` (defaults to
  `https://oauth2.googleapis.com/token`), decodes the `id_token`
  payload for `email` + `name` (rejects `email_verified === false`),
  find-or-creates the `users` row, mints `keepsake_session` via the
  P6-A helper. Every callback response (success or failure) clears
  the auth state cookie.
- `lib/repositories/users.{ts,server.ts}` — minimal users repo:
  `findByEmail(email, tx?)` + `createFromGoogleProfile({ email,
  displayName }, tx?)`. Runs inside `workerTransaction` because the
  sign-in path discovers identity before it knows the owner.
- `app/api/auth/google/start/route.ts` (GET) — thin: parse
  `returnTo`, delegate to `startGoogleSignIn`, apply 307 +
  state-cookie or JSON error.
- `app/api/auth/google/callback/route.ts` (GET) — thin: parse
  `code` / `state` / `error` query params + state cookie, delegate
  to `completeGoogleSignIn`, apply 307 + session cookie + cleared
  state cookie on success, JSON error + cleared state cookie on
  failure.
- Env vars: `KEEPSAKE_AUTH_GOOGLE_CLIENT_ID` / `_SECRET` /
  `_REDIRECT_URI` (with `__ORIGIN__` magic value),
  `KEEPSAKE_AUTH_GOOGLE_AUTH_URL` (default Google), `KEEPSAKE_AUTH_GOOGLE_TOKEN_ENDPOINT`
  (default Google). State cookie reuses `OAUTH_STATE_SIGNING_SECRET`.
- Routes registered: `/api/auth/google/start`, `/api/auth/google/callback`.
- `.env.example` documents the new env vars and explicitly notes
  that this is a SEPARATE OAuth client from the Gmail sender flow.

Explicit out of scope for P6-B:

- **No** Gmail sender connect / disconnect changes. The
  `gmail_accounts` table and `/api/oauth/gmail/*` flow are
  untouched.
- **No** sign-in UI / `/signin` page. Callers wire the start URL
  themselves.
- **No** middleware / page redirects. Pages still reach the auth
  seam directly; `DEV_OWNER_*` fallback is preserved so the existing
  smoke suite stays unchanged.
- **No** people seed on user creation. New users get an empty
  workspace until they add anyone.
- **No** id_token JWT signature verification against Google's JWKS.
  We trust the TLS chain to `KEEPSAKE_AUTH_GOOGLE_TOKEN_ENDPOINT`
  the same way the existing Gmail callback does.
- **No** removal of the `DEV_OWNER_*` fallback. That retirement
  lands when sign-in is also the only on-ramp, in a later slice.
- Sign-in callback REQUIRES `KEEPSAKE_DATA_SOURCE=db` — mock mode
  returns 501 `not_configured` because there's no DB to persist
  users into.

### P6-C. Sign-in Page + Unauthenticated Page Redirects

Status: done. Guarded by `pnpm test:auth` — the new `test-signin.mjs`
script adds 32 assertions across 6 phases (signin page renders for
unauth + Google CTA shape, signin authed → returnTo, dev CTA
visibility gated by `ENABLE_DEV_SESSION_ROUTES`, all 5 product pages
redirect unauth → `/signin` with the correct `returnTo`, all 5
product pages 200 with a valid cookie, misconfigured auth surfaces
as 500 NOT a /signin redirect). The existing 4 page smokes
(`test-home`, `test-profile`, `test-workspace`, `test-history`) now
mint a real `keepsake_session` cookie at the start of each smoke so
the existing assertions still hold under the stricter page guard.

Goal: turn P6-B's Google sign-in transport into a real product
entrypoint. After P6-C, opening any of the 5 in-product pages
unauthenticated lands the user on `/signin`, signing in returns
them to the page they wanted, and a deployment-level auth break
shows a 500 instead of looping users back to `/signin`.

Shipped:

- `app/signin/page.tsx` — server component. Renders a minimal CTA
  page when the visitor has no session; 307s to `returnTo` (default
  `/`) when they do. Google CTA is always visible; "Continue as dev
  owner" form appears only when `ENABLE_DEV_SESSION_ROUTES=1`.
- `lib/server/auth/require-session.server.ts` — new helper
  `requireSessionUserOrRedirect(returnTo)`. Cookie-only via
  `currentSessionUserOrThrow()`; unauthenticated → `redirect("/signin?returnTo=…")`;
  misconfigured → re-raises as 500. Also exports a strict
  `safeReturnTo()` (only relative paths survive).
- `lib/server/auth/current-user.server.ts` — new export
  `currentSessionUserOrThrow()`. Same shape as
  `currentUserOrThrow()` but skips the `DEV_OWNER_*` env fallback.
- `app/{,people,workspace,history,profile}/page.tsx` migrated to
  `requireSessionUserOrRedirect()`. Each page declares its own
  `returnTo` (workspace preserves `?person=…`).
- `app/api/auth/dev-session/start/route.ts` extended: when
  `?returnTo=` is present in the query, the route 303s with the
  session cookie attached so the `/signin` dev-CTA form gets a
  proper redirect; without it, the original 200 + JSON receipt is
  preserved.
- The 4 page smokes (`test-home`, `test-profile`, `test-workspace`,
  `test-history`) gained a `mintSession()` setup step that POSTs to
  `/api/auth/dev-session/start` once at boot and threads the
  cookie through subsequent fetches. The existing assertions are
  unchanged.

Out of scope (still future slices):

- **No** middleware. Each page guards itself; no global
  authenticated-by-default behaviour.
- **No** global navigation / logout button. `/api/auth/dev-session/clear`
  exists as a CLI tool; a UI logout lands in a later slice.
- **No** removal of the `DEV_OWNER_*` fallback from the
  cookie-first `currentUserOrThrow()` path. The API / route / seam
  layer continues to allow env fallback so existing smokes don't
  need a sign-in step.
- **No** Gmail-sender flow changes. Profile / Workspace / Gmail
  connect-disconnect routes still work identically.
- **No** mobile-specific layout for `/signin` — desktop-first
  minimal layout only.

### P5. People Editing MVP

### P5. People Editing MVP

Goal: allow creating/editing people and occasions from the UI.

Owner: Codex implementation agent after DB write policy is reviewed.

In scope:

- People repository write methods.
- Route handlers.
- Form UI and validation.

Out of scope:

- Bulk imports, contact sync, calendar sync.

### P6. Command Channel Platform

Goal: make WhatsApp, Telegram, Slack, and similar chat tools act as
natural-language command inputs and notification surfaces without building a
native mobile app.

Owner: Codex implementation agent after the architecture brief is reviewed.

Product stance:

- Channels are command surfaces, not full clients.
- Web remains the execution workspace for final send, detailed editing,
  account setup, and high-risk confirmation.
- WhatsApp is especially important for user tasks and notifications:
  "recently, what relationships need follow-up?" or "help me write Helen a
  congratulatory email for her promotion."
- Telegram and Slack should reuse the same core command router through channel
  adapters, not duplicate business logic.

Core abstraction:

```ts
type CommandEvent = {
  provider: "whatsapp" | "telegram" | "slack";
  externalUserId: string;
  externalConversationId: string;
  messageId: string;
  text: string;
  receivedAt: string;
};

type CommandResponse =
  | { kind: "text"; text: string }
  | { kind: "choices"; text: string; actions: CommandAction[] }
  | { kind: "workspace_link"; text: string; href: string };
```

In scope:

- Channel identity/linking model: provider account maps to Keepsake owner; it
  is not auth itself.
- Normalized inbound command event and outbound response contracts.
- Provider adapters for WhatsApp, Telegram, and Slack over a shared command
  router.
- First intents:
  - relationship follow-up query
  - create draft from instruction
  - revise draft tone/length
  - open Workspace link
- Notification path for reminders, with provider-specific rules.

Out of scope:

- No native mobile app.
- No automatic final send from chat by default.
- No provider-specific business logic in the command router.
- No channel adapter should call `app/api/*` over HTTP, `lib/mock.ts`,
  `draft-generator` directly, Gmail OAuth/account repositories, crypto helpers,
  or worker-only delivery methods.

Initial implementation sequence:

1. Write `docs/COMMAND_CHANNELS.md` architecture brief.
2. Add type-only `lib/server/channels/types.ts`.
3. Add `lib/server/channels/command-router.server.ts` skeleton with no LLM.
4. Add WhatsApp webhook contract stub and smoke tests.
5. Add Telegram webhook/link contract stub and smoke tests.
6. Add Slack event/slash-command contract stub and smoke tests.
7. Implement first read-only intent: "what relationships need follow-up?"
8. Implement "create draft from command" by calling owner-explicit draft
   service internals and returning a Workspace link.

Required validation:

- Boundary tests proving channel adapters call server seams, not app routes or
  mocks.
- Route smoke tests for provider verification failure, malformed payloads,
  duplicate events, unknown channel account, and valid text command.
- DB tests later for channel account RLS, hashed provider lookup, encrypted raw
  identifiers, one-time link tokens, and event idempotency.

CC review focus:

- Channels are provider adapters; command logic is shared.
- Webhooks do not use web session auth or `currentUserIdOrThrow()`.
- Provider identities are not written onto `users`.
- WhatsApp policy constraints are respected: inbound user tasks can be answered
  inside the customer-service window; proactive reminders require templates or
  a template-aware notification layer.

## Cross-Cutting Backlog

| Priority | Task | Why It Matters |
|---|---|---|
| P1 | Add CI script/checklist | Prevents local-only confidence. |
| P1 | Visual regression screenshots for desktop views | UI proportion drift already happened once. |
| P2 | Mobile layout pass | Current UI is desktop-first. |
| P2 | Structured logger | Replace bare `console.error` before production. |
| P2 | Migration strategy | Current SQL is bootstrap-style; production needs migrations. |
| P3 | Import contacts/calendar strategy | Product growth path, not MVP-critical. |
| P3 | Print/card provider research | Needed for physical keepsake flow. |

## Task Prompt Template

Use this when assigning a Codex implementation agent:

```text
Implement [TASK NAME] in /Users/apple/keepsake/web.

Context:
- Current checkpoint: [commit hash]
- Relevant docs: docs/DEVELOPMENT_PROGRESS.md, docs/CURRENT_ARCHITECTURE.md,
  lib/server/README.md, lib/repositories/README.md

Goal:
- [one sentence]

In scope:
- [bullets]

Out of scope:
- [bullets]

Expected files:
- [paths]

Validation:
- pnpm test
- pnpm build
- [specific test command]
- git diff --check

Report back:
- files changed
- behavior summary
- validation results
- git status
- leftover servers/containers
```

Use this when assigning CC read-only review:

```text
Read-only review for [TASK NAME].

Do not edit code.

Review scope:
- [paths]

Check:
- [invariants]
- tests
- docs
- out-of-scope boundaries

Return:
- blockers
- non-blocking notes
- checkpoint recommendation
```

## Checkpoint Policy

Checkpoint when all are true:

- Implementation scope matches the task.
- Required tests pass.
- CC has no blockers, or blockers have been fixed and re-reviewed.
- `git status --short` is clean after commit.
- No Keepsake test Docker containers or dev servers are left behind.
