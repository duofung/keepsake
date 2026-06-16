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
| Draft generation/persistence | Stable mock generator + DB persistence | DB-backed draft context/service, draft repository, latest/version reads. | Replace mock generator with real LLM behind same seam. |
| Delivery history | Stable read path | DB-backed history page and deliveries read repository. | Send/enqueue/webhook/worker write paths. |
| Auth/current user | Stable dev + DB sender seam | `currentUserOrThrow`, `/api/session`, Home/Profile/Workspace identity wiring, DB-mode `sendingAccount` hydration from primary Gmail account. | Real session/OAuth auth. |
| Gmail OAuth | Stable start + callback | Full HMAC state cookie, native-fetch token exchange, account upsert on success, cookie cleared on every response. | Token refresh + markExpired on send failure, Google revoke on disconnect. |
| Sending account UI | Connect/Disconnect wired | Profile shows Not connected / Connected / Expired with Connect / Reconnect / Disconnect CTAs that drive `/api/oauth/gmail/start` and `POST /api/gmail/disconnect`. Idempotent + cross-owner safe. | Auto-repair on expired refresh, Google revoke on disconnect, multi-account support. |
| Email send | Stable enqueue boundary + Workspace wiring | `POST /api/deliveries` + `lib/server/delivery-send/*` enqueue queued rows with sender precondition (email) and ownership checks; Workspace `Send email` / `Mail as card` now call this boundary and surface queued/error state honestly. Returns 202 "queued/accepted"; no Gmail call yet. | Gmail send worker, status updates, webhooks, persisting Workspace client-local edits into the queued draft. |
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
- No persistence of client-local Workspace edits (subject input, card
  toggle). The queued draft is the latest server-saved draft for the
  person/occasion pair.

### P4. Real Draft Generator

Goal: replace mock generator with an LLM implementation behind
`draft-generator`.

Owner: Codex implementation agent.

In scope:

- Prompt schema using person, relationship, culture, occasion, history, and user
  instruction.
- JSON validation and fallback.
- Preserve `MessageDraft` shape.

Out of scope:

- No UI redesign.
- No send behavior.

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
