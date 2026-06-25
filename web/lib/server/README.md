# `lib/server/` — server-only seams and services

Where server-only orchestration lives. This directory keeps `app/` and
`components/` away from `lib/mock.ts`, SQL, crypto, and future auth/LLM
clients. People payload, the ReMaster compatibility runtime for Home + People + Workspace + History,
draft generation orchestration, latest draft restore, draft version history,
draft context, delivery history, and the send-boundary queue now have
DB-capable runtime verticals.
Draft generation is still mock-backed; only DB mode persists/caches generated
message drafts, restores the newest saved draft, and lists recent draft
versions for Workspace.

The rule is simple: framework code calls `lib/server/*`; `lib/server/*`
dispatches to mocks or repositories/services without leaking that choice into
`app/`.

## What lives here

Each service is a single concern. The seams, dev auth current-user resolver,
crypto envelope helper, and DB transaction helper that exist now are real
code; production auth/KMS remain later passes.

```
lib/server/
├── README.md
├── remaster-overview/
│   └── index.server.ts      ← current: compatibility account/contact/activity overview for Home + People + Workspace + History
├── people-payload/
│   ├── index.server.ts       ← current: mock/db dispatcher
│   ├── mock.server.ts        ← current: mock fallback
│   └── db.server.ts          ← current: DB-backed PeoplePayload
├── people-create/
│   ├── index.server.ts       ← current: request validation + mock/db dispatcher
│   ├── mock.server.ts        ← current: preview Person response for local UI persistence
│   └── db.server.ts          ← current: DB-backed PeopleRepository.create
├── delivery-history/
│   ├── index.server.ts       ← current: mock/db dispatcher
│   ├── mock.server.ts        ← current: mock fallback
│   └── db.server.ts          ← current: DB-backed History data
├── delivery-send/
│   ├── index.server.ts       ← current: mock/db dispatcher for POST /api/deliveries
│   ├── mock.server.ts        ← current: validates + synthetic QueuedDelivery
│   ├── db.server.ts          ← current: validate → ownership → sender → latest draft → enqueue
│   └── types.ts              ← SendBoundaryResult contract
├── delivery-worker/
│   ├── index.server.ts                ← current: processNextQueuedEmail() + recoverStaleSendingDeliveries() + runWorkerLoop()
│   ├── runtime.server.ts              ← current: pure-logic loop with injected tick + recover deps
│   ├── db.server.ts                   ← current: claim/hydrate/finalise across 3 worker tx + stale recovery
│   ├── mock.server.ts                 ← current: nothing_to_do + recovery no-op
│   ├── gmail-transport.server.ts      ← current: native-fetch Gmail send + token refresh
│   └── types.ts                       ← WorkerResult / WorkerFailureReason
├── delivery-webhook/
│   ├── ingest.server.ts               ← current: provider-agnostic event validate + mock/db dispatcher
│   ├── mock.server.ts                 ← current: every valid event → delivery_not_found
│   ├── db.server.ts                   ← current: findByProviderMessageId + markStatus inside workerTransaction
│   └── types.ts                       ← WebhookIngestInput / WebhookIngestResult
├── draft-context/
│   ├── index.server.ts       ← current: mock/db dispatcher
│   ├── mock.server.ts        ← current: mock fallback
│   └── db.server.ts          ← current: DB-backed DraftContext
├── draft-service/
│   ├── index.server.ts             ← current: data-source dispatcher for /api/drafts (POST + GET + PATCH)
│   ├── mock.server.ts              ← current: mock POST + PATCH + latest + versions over in-memory store
│   ├── db.server.ts                ← current: DB context + draft cache/save/latest/versions + edit-save
│   ├── mock-store.server.ts        ← current: process-local in-memory mock draft store
│   ├── edit-input.ts               ← shared PATCH-shape validation + base-equal check
│   ├── generator-errors.server.ts  ← current: DraftGeneratorError → DraftServiceResult mapping
│   └── types.ts                    ← draft service contracts (incl. DraftEditInput)
├── draft-generator/
│   ├── types.ts              ← DraftContext / DraftGenerator / error-kind contracts
│   ├── index.server.ts       ← current: mock/openai dispatcher (KEEPSAKE_DRAFT_SOURCE)
│   ├── mock.server.ts        ← current: mock MessageDraft generator + deterministicRecipe
│   └── openai.server.ts      ← current: OpenAI-compatible chat-completions adapter
├── auth/                     ← current: dev owner seam; future real auth
│   └── current-user.server.ts
├── oauth/                    ← current: provider route contracts only
│   └── gmail.server.ts
├── channel-accounts/         ← Profile-facing read + mock/Telegram link/revoke seam (P8-F/P8-I/P8-J)
│   └── profile.server.ts
├── channels/                 ← command-channel router + mock provider adapter + owner-scoped read path
│   ├── types.ts
│   ├── router.server.ts
│   ├── command-service.server.ts
│   ├── mock-inbound.server.ts
│   ├── telegram-start-token.server.ts
│   └── telegram.server.ts
├── db/                       ← current: request-path transaction helper
│   └── transaction.server.ts
└── crypto/                   ← current: dev AES-GCM envelope helper
    └── envelope.server.ts
```

### Naming

All implementation files use `*.server.ts`. The convention is the same as
[`lib/repositories/`](../repositories/README.md#implementation-file-naming):
the suffix is the human-readable convention, and each implementation file
must also start with `import "server-only";`. The package import is the
build-time guard that makes client-side imports fail rather than leaking
server code into a browser bundle.

Type-only files (signatures, input shapes) drop the `.server` suffix and
sit next to the implementation. Runtime implementations keep the suffix.

## Boundary rules

1. **Server-only, by both filename and review policy.** Same rule as repos.
2. **Each service owns one thing.** No "utils" grab-bag; each subfolder is
   its own contract.
3. **Only server code imports `lib/server/`.** Server components and route
   handlers may import it. `"use client"` modules must not.
4. **Only mock seams import `lib/mock.ts`.** Today that means
   `people-payload/mock.server.ts`, `delivery-history/mock.server.ts`, and
   `draft-context/mock.server.ts`. This is checked by `pnpm test:boundaries`.
5. **No HTTP types past `auth/`.** Only `current-user` knows about
   `Request`, cookies, or session tokens; everyone else takes resolved
   values.
6. **Provider webhooks are not web auth.** Future WhatsApp/Telegram/Slack
   webhook routes must verify provider signatures/secrets and resolve channel
   account ownership through channel services. They must not call
   `currentUserIdOrThrow()`, because there is no web session on an inbound
   provider webhook.
7. **No domain logic in generic services.** Tone selection, prompt wording,
   relationship-aware fallbacks — those live in the route handler or in
   `draft-generator`. `db/`, `crypto/`, `auth/` stay generic.
8. **Stateless calls.** Services may hold a connection pool or a KMS
   client at module scope, but a single request must not mutate
   module-level state observable to the next request.

## Services

### Current runtime seams

These are the files that should move when the back end goes real. They are
small on purpose.

| Seam | Called by | Today | Future replacement | Guard |
|---|---|---|---|---|
| `auth/current-user.server.ts` | `/api/session`, Home, Workspace, Profile, DB-backed server helpers, the dev-session bootstrap routes | Resolves `{ id, email, name, initials, sendingAccount }` from the `keepsake_session` cookie FIRST (HMAC-signed payload — see `auth/session.server.ts`), falling back to `DEV_OWNER_*` env ONLY when no cookie is present. A present-but-invalid cookie raises `AuthError("unauthenticated")` and never silently degrades. Mock mode returns `sendingAccount: null`; DB mode hydrates it from the owner primary Gmail account. Both `currentUserOrThrow()` and `currentUserIdOrThrow()` are async (P6-A migrated every call site). | Real sign-in / Google identity provider land inside `session.server.ts` + a new route; this file keeps its public shape. | `pnpm test:auth`, `pnpm test:home`, `pnpm test:workspace`, `pnpm test:profile`, `pnpm test:db:current-user`, `pnpm test:boundaries` |
| `auth/session.server.ts` | `auth/current-user.server.ts`, `app/api/auth/dev-session/*`, `auth/google-signin.server.ts` | Stateless `keepsake_session` cookie helper. `issueSessionCookie({ ownerId, email, name, nowMs?, ttlSeconds?, secure? })` produces `<base64url payload>.<base64url HMAC-SHA256(payload)>`; `verifySessionCookie({ cookieValue, nowMs? })` validates signature + expiry. Secret = `APP_SESSION_SIGNING_SECRET` (≥32 chars). Errors normalise to `SessionError("unauthenticated" \| "misconfigured", …)` so the call site can map to the same HTTP shape as the rest of the auth seam. Cookie attributes: HttpOnly, SameSite=Lax, Path=/, Secure on https origins. Also exports `isDevSessionRoutesEnabled()` — both `/api/auth/dev-session/start` and `/api/auth/dev-session/clear` are gated behind `ENABLE_DEV_SESSION_ROUTES=1` and 404 when unset, so the routes can ship without being reachable in production. No DB session table — that lands in a later slice if/when needed. | Real refresh-token / multi-session work can swap the payload shape; the route layer stays the same. | `pnpm test:auth` (sign/verify roundtrip + tamper + expiry + missing-secret + gate-disabled + bootstrap-ignores-cookie) |
| `auth/require-session.server.ts` | `app/{,people,workspace,history,profile}/page.tsx`, `app/signin/page.tsx`, `app/api/auth/signout/route.ts` | Page-level guard. `requireSessionUserOrRedirect(returnTo)` calls `currentSessionUserOrThrow()` (cookie-only — no `DEV_OWNER_*` fallback); unauthenticated → `redirect("/signin?returnTo=…")`; misconfigured → re-raises so Next surfaces a 500. Exports a strict `safeReturnTo(input, fallback?)` that accepts only relative paths; the signout route passes `fallback="/signin"` so unsafe values land back on sign-in rather than `/`. The route / API / server-seam layer continues to use the permissive `currentUserOrThrow()`; the split is intentional. | Future identity provider work composes on top of the same helper. | `pnpm test:auth` (test-signin.mjs + test-signout.mjs: signin render + dev CTA gating + page redirects + misconfigured → 500 + signout 303 + cookie clear + profile form HTML) |
| `auth/google-signin.server.ts` | `app/api/auth/google/start`, `app/api/auth/google/callback` | Google identity sign-in transport (P6-B). `startGoogleSignIn({ returnTo, origin })` signs a state cookie (`OAUTH_STATE_SIGNING_SECRET`, distinct cookie name from the Gmail OAuth flow), redirects to `KEEPSAKE_AUTH_GOOGLE_AUTH_URL` with `openid email profile` scope — **never** `gmail.send`. `completeGoogleSignIn({ code, state, providerError, stateCookie, origin })` verifies the state cookie, exchanges the code at `KEEPSAKE_AUTH_GOOGLE_TOKEN_ENDPOINT`, decodes the `id_token` for email + name (rejects `email_verified === false`), find-or-creates a `users` row via `UsersRepository`, and mints a `keepsake_session` cookie via the P6-A helper. Requires `KEEPSAKE_DATA_SOURCE=db`. Does NOT touch `gmail_accounts` or `CurrentUser.sendingAccount` — this is purely identity transport. Every callback response (success or failure) clears the auth state cookie. | A future provider-agnostic identity seam slots in here; the routes stay thin. | `pnpm test:auth` (default route smoke), `pnpm test:db:google-signin` (users row create/reuse + session cookie minted) |
| `oauth/gmail.server.ts` | `GET /api/oauth/gmail/start`, `GET /api/oauth/gmail/callback` | Full Gmail OAuth flow. Start signs a state cookie with HMAC-SHA256 (`OAUTH_STATE_SIGNING_SECRET`) and redirects to Google with `openid email gmail.send` scopes. Callback verifies the cookie (signature, TTL, owner, state match), POSTs the authorization code to `GOOGLE_TOKEN_ENDPOINT` via native `fetch`, extracts the account `email` from the returned `id_token`, opens one short `transaction(ownerId, ...)` and persists encrypted refresh-token metadata through `GmailAccountRepository.upsertPrimary`. All callback responses (success or failure) clear the state cookie. The seam never sends mail and never queues anything. | Real auth replaces `currentUserIdOrThrow()`; the rest of the seam is unchanged. | `pnpm test:oauth`, `pnpm test:db:gmail-callback`, `pnpm test:boundaries` |
| `gmail-account/disconnect.server.ts` | `POST /api/gmail/disconnect` | Idempotent disconnect of the caller's primary Gmail account. Mock mode short-circuits before opening a transaction; DB mode looks up `GmailAccountRepository.getPrimary(ownerId)` and, when a row exists, delegates to `GmailAccountRepository.disconnect(ownerId, accountId)` inside a short `transaction(ownerId, ...)`. Returns a plain `{ redirectTo }` so the route can `303` the user back to `/profile`. Shares the strict `dataSource()` from the auth seam — a misconfigured `KEEPSAKE_DATA_SOURCE` raises `AuthError("misconfigured")` and the route maps it to 500, matching `/api/session`. No Google revoke call; no SQL outside the repo. | Real auth replaces `currentUserIdOrThrow()`. Future `markExpired`-on-send-failure and Google revoke can compose on top without changing this seam. | `pnpm test:profile`, `pnpm test:gmail-disconnect`, `pnpm test:db:current-user`, `pnpm test:boundaries` |
| `remaster-overview/index.server.ts` | Home, People, Workspace, History | Composes `getPeoplePayload()` and `getDeliveryHistory()` into derived account/contact/activity read models. `getRemasterDashboardOverview()` powers Home; `getRemasterPeopleCompatibilityView()` powers People and returns the legacy payload only for drawer/add compatibility; `getRemasterWorkspaceCompatibilityView()` powers Workspace account/contact framing while keeping legacy draft compatibility; `getRemasterHistoryCompatibilityView()` powers History activity framing while keeping the existing `Delivery[]` read path. Page-only, no new API contract. | Replace the derivation with native ReMaster storage later. | `pnpm test:home`, `pnpm test:people`, `pnpm test:workspace`, `pnpm test:history` |
| `people-payload/index.server.ts` | `GET /api/people`, `remaster-overview/index.server.ts` | Dispatches by `KEEPSAKE_DATA_SOURCE`: mock by default, DB when set to `db`. People no longer imports this seam directly; it receives legacy payload through the ReMaster compatibility view while `/api/people` keeps returning `PeoplePayload`. | Real auth owner resolution; eventually delete mock fallback | `pnpm test:people`, `pnpm test:db:people-route`, `pnpm test:boundaries` |
| `people-payload/mock.server.ts` | `people-payload/index.server.ts` | `peoplePayload()` from `lib/mock.ts` | Deleted when DB is the only source | `pnpm test:people`, `pnpm test:boundaries` |
| `people-payload/db.server.ts` | `people-payload/index.server.ts` | `currentUserIdOrThrow()` + `transaction(ownerId)` + `PeopleRepository.listWithRelations(ownerId)` | Same repository call with real auth | `pnpm test:db:people-route` |
| `people-create/index.server.ts` | `POST /api/people`, People "Add contact" | Validates `{ name, relationshipId, cultureId, since?, note?, starred? }`, derives avatar + first known fact, dispatches by `KEEPSAKE_DATA_SOURCE`, and returns a `Person`. Mock mode returns a `local-*` preview person for browser-local persistence; DB mode writes through `PeopleRepository.create`. | Future People edit/archive/date routes stay sibling seams; this POST route remains thin. | `pnpm test:db:people`, `pnpm test:db:people-route` |
| `people-create/db.server.ts` | `people-create/index.server.ts` | `currentUserIdOrThrow()` + `transaction(ownerId)` + `PeopleRepository.create(ownerId, input)`; FK misses map to 400 `invalid_reference`; no SQL in the route. | Same repository call with real auth. | `pnpm test:db:people-route` |
| `delivery-history/index.server.ts` | `remaster-overview/index.server.ts` for History framing | Dispatches by `KEEPSAKE_DATA_SOURCE`: mock by default, DB when set to `db`; History reaches it through the ReMaster compatibility seam, not directly from the page | Real auth owner resolution; eventually delete mock fallback | `pnpm test:history`, `pnpm test:db:history-route`, `pnpm test:boundaries` |
| `delivery-history/mock.server.ts` | `delivery-history/index.server.ts` | `deliveries` from `lib/mock.ts` | Deleted when DB is the only source | `pnpm test:history`, `pnpm test:boundaries` |
| `delivery-history/db.server.ts` | `delivery-history/index.server.ts` | `currentUserIdOrThrow()` + `transaction(ownerId)` + `DeliveryRepository.listByMonth(ownerId, { limit: 50 })`; read-only History DB mode | Same repository read with real auth; send/enqueue/webhook/worker remain separate future paths | `pnpm test:db:deliveries`, `pnpm test:db:history-route` |
| `delivery-send/index.server.ts` | `POST /api/deliveries` | Dispatches `enqueueDelivery(input)` by `KEEPSAKE_DATA_SOURCE` and returns a `SendBoundaryResult` discriminated union the route maps to HTTP status. The route is a queue boundary — no Gmail call, no status mutation. | Real auth replaces `currentUserIdOrThrow()`; a future Gmail send worker drains queued rows out-of-band. | `pnpm test:deliveries`, `pnpm test:db:deliveries-route`, `pnpm test:boundaries` |
| `delivery-send/mock.server.ts` | `delivery-send/index.server.ts` | Shared `validateRequest` (UUID + channel guards) plus `enqueueMockDelivery` returning a synthetic `QueuedDelivery`. | Deleted when DB is the only source. | `pnpm test:deliveries`, `pnpm test:boundaries` |
| `delivery-send/db.server.ts` | `delivery-send/index.server.ts` | `currentUserIdOrThrow()` + one `transaction(ownerId)` for `resolveDbDraftContextInTx` (ownership), `GmailAccountRepository.getPrimary` (email-only sender precondition), `DraftRepository.getLatestFor` (no-draft check), and `DeliveryRepository.enqueue` (status=queued, sent_at=NULL, encrypted recipient_*). | Same orchestration with real auth; the worker now drains queued rows (see below). | `pnpm test:db:deliveries-route` |
| `delivery-worker/index.server.ts` | `pnpm worker:run`; future cron | `processNextQueuedEmail()` + `recoverStaleSendingDeliveries()` both dispatch by `KEEPSAKE_DATA_SOURCE`. `runWorkerLoop(options)` is the loop wrapper that wires the runtime to those dispatchers — drives one recovery pass (if requested) followed by bounded ticks until empty/misconfigured/max_ticks/fatal_error. | Future cron / daemon wraps repeated calls to `runWorkerLoop`; route handlers still don't import this seam. | `pnpm test:delivery-worker`, `pnpm test:db:delivery-worker` |
| `delivery-webhook/ingest.server.ts` | `POST /api/webhooks/deliveries` | Provider-agnostic delivery status ingest. `ingestDeliveryWebhookEvent({ provider, providerMessageId, event, occurredAtISO?, failureReason?, providerStatus? })` validates the event shape (provider ∈ {gmail, mock}, event ∈ {delivered, opened, failed}) and dispatches by `KEEPSAKE_DATA_SOURCE`. Identity = `providerMessageId`; `deliveries.provider_message_id` is DB-unique when non-null (partial UNIQUE index), so webhook lookup is unambiguous. The seam never reads `currentUser*`; the route gates on shared `DELIVERY_WEBHOOK_SECRET` before calling in. | A real Gmail push subscription wires `provider: "gmail"` events into this seam without changing the contract. | `pnpm test:webhook-deliveries`, `pnpm test:db:webhook-deliveries`, `pnpm test:boundaries` |
| `delivery-webhook/mock.server.ts` | `delivery-webhook/ingest.server.ts` | Mock dispatch — no `deliveries` rows exist, so every event resolves to `delivery_not_found`. Keeps the secret-gate / body-validation contract exercisable without Postgres. | Deleted when DB is the only source. | `pnpm test:webhook-deliveries` |
| `delivery-webhook/db.server.ts` | `delivery-webhook/ingest.server.ts` | One `workerTransaction` (BYPASSRLS) per request: `DeliveryRepository.findByProviderMessageId(providerMessageId)` → on miss, return 404; on hit, map `event → DeliveryStatus` and call `DeliveryRepository.markStatus({ deliveryId, status, providerStatus?, deliveredAtISO?, openedAtISO?, failureReason? })`. `opened` events also pass `deliveredAtISO` so `delivered_at` gets filled even when the provider skipped the delivered event. | Future per-provider HMAC verification + retry queue land on top; the seam stays. | `pnpm test:db:webhook-deliveries` |
| `delivery-worker/runtime.server.ts` | `delivery-worker/index.server.ts` (production); test scripts (with injected deps) | Pure-logic `runDeliveryWorkerLoop(options, deps)`. No static runtime imports — `deps.tick` and `deps.recover` are explicit so the smoke can drive the loop with stubs, the production wrapper binds real dispatchers. Returns `{ ticks, sent, failed, recovered, stopReason, missing?, fatalError? }`. | Stays pure logic. | `pnpm test:delivery-worker` (10 dedicated phases) |
| `delivery-worker/db.server.ts` | `delivery-worker/index.server.ts` | Three `workerTransaction` blocks per single tick: (1) `DeliveryRepository.nextQueued(1)` + `markStatus(id, 'sending')` to claim; (2) `DraftRepository.getEditBaseById` + `GmailAccountRepository.getSendingCredentials` to hydrate; (3) `markStatus(id, 'sent', providerMessageId)` or `markStatus(id, 'failed')`. On `token_invalid`, also `markExpired(gmail_account)`. No DB lock held across Gmail HTTP. Also exports `recoverStaleSendingDeliveriesDb(seconds)` → `DeliveryRepository.requeueStaleSending(seconds)` for the loop's stale-recovery pass. | A retry queue / dead-letter classification is its own slice. | `pnpm test:db:delivery-worker` |
| `delivery-worker/gmail-transport.server.ts` | `delivery-worker/db.server.ts` | Native `fetch` Gmail transport: `POST GOOGLE_TOKEN_ENDPOINT` for refresh→access, then `POST KEEPSAKE_GMAIL_API_BASE /gmail/v1/users/me/messages/send` with `raw=base64url(plain-text MIME)`. Per-delivery failures normalise into `GmailTransportError` (`token_invalid` / `gmail_send_error` / `transport_error`); a global env miss (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) is a deployment problem, not a delivery problem — it throws `WorkerMisconfiguredError` from `assertGmailTransportConfig()` and surfaces to operators as `WorkerResult.status === "misconfigured"` WITHOUT touching the queue. Endpoints env-overridable for tests. | Swap for a streaming or service-account adapter without touching the worker. | `pnpm test:delivery-worker`, `pnpm test:db:delivery-worker` |
| `draft-service/index.server.ts` | `GET /api/drafts`, `POST /api/drafts`, `PATCH /api/drafts`, `GET /api/drafts/versions` | Dispatches by `KEEPSAKE_DATA_SOURCE`: mock by default, DB when set to `db`. PATCH delegates to `saveDraftEdit` on the same dispatcher. | Same route seam with real auth/LLM behind it | `pnpm test:drafts`, `pnpm test:db:drafts-route`, `pnpm test:boundaries` |
| `draft-service/mock.server.ts` | `draft-service/index.server.ts` | Mock POST + PATCH + latest + versions, all backed by the process-local `mock-store.server.ts`. POSTed drafts and PATCH-edited versions round-trip across the same Node process. | Deleted when DB is the only source | `pnpm test:drafts`, `pnpm test:boundaries` |
| `draft-service/db.server.ts` | `draft-service/index.server.ts` | `currentUserIdOrThrow()` + one `transaction(ownerId)` for DB context, prompt hash lookup, generation on miss, and `DraftRepository.save` on POST; same transaction + context validation + `DraftRepository.getLatestFor` on GET latest restore; context validation + `DraftRepository.listForPerson` for version history; `DraftRepository.getById` + `DraftRepository.save` (with `promptHash = NULL`) for PATCH. Cross-owner / unknown / non-UUID draftIds all return 404 without distinguishing. | Same orchestration with real auth and a future LLM generator | `pnpm test:db:drafts-repository`, `pnpm test:db:drafts-route` |
| `draft-service/mock-store.server.ts` | `draft-service/mock.server.ts` | Module-scope `Map<draftId, MessageDraft>` plus a per-(personId, occasionId) newest-first list. Lets PATCH find a base draft by id and lets latest/versions reads reflect what POST + PATCH wrote in the same process. | Removed when mock is gone. | `pnpm test:drafts` |
| `draft-service/edit-input.ts` | `draft-service/{mock,db}.server.ts` | Pure validator for the PATCH body shape + a `editMatchesBase` deep-equal that suppresses no-op version inserts. Type-only consumers can import it without server runtime. | Stays as a shared validator. | `pnpm test:drafts`, `pnpm test:db:drafts-route` |
| `draft-context/index.server.ts` | `POST /api/drafts` | Dispatches by `KEEPSAKE_DATA_SOURCE`: mock by default, DB when set to `db` | Real auth owner resolution; eventually delete mock fallback | `pnpm test:drafts`, `pnpm test:db:drafts-route`, `pnpm test:boundaries` |
| `draft-context/mock.server.ts` | `draft-context/index.server.ts` | validates ids and builds `DraftContext` from mock finders | Deleted when DB is the only source | `pnpm test:drafts`, `pnpm test:boundaries` |
| `draft-context/db.server.ts` | `draft-context/index.server.ts`, `draft-service/db.server.ts` | `currentUserIdOrThrow()` + `transaction(ownerId)` + People/Catalog repo hydration; also exposes an in-transaction resolver for draft persistence | Same repository composition with real auth | `pnpm test:db:drafts-route` |
| `draft-generator/index.server.ts` | `draft-service/{mock,db}.server.ts` | `getDraftGenerator()` reads `KEEPSAKE_DRAFT_SOURCE` (default `mock`, opt-in `openai`), caches the constructed generator, and throws `DraftGeneratorError("misconfigured", …)` on unknown values. Independent of `KEEPSAKE_DATA_SOURCE` — all four data×generator combinations are valid. | Add more provider adapters as new files; route signature stays the same. | `pnpm test:draft-generator` |
| `draft-generator/mock.server.ts` | `draft-generator/index.server.ts` | mock recipe + instruction rewrite to `MessageDraft`; also exports `deterministicRecipe(ctx)` for the LLM adapter to reuse for `attachedCard` + `quickActions`. | Kept as the default + the deterministic recipe source. | `pnpm test:drafts`, `pnpm test:draft-generator` |
| `draft-generator/openai.server.ts` | `draft-generator/index.server.ts` | OpenAI-compatible chat-completions adapter. Validates `KEEPSAKE_DRAFT_API_KEY` / `KEEPSAKE_DRAFT_API_BASE` / `KEEPSAKE_DRAFT_MODEL` at construction; POSTs `system + user` JSON to `/v1/chat/completions` with `response_format: json_object`; parses + validates tone, subject, paragraphs, assistantNote against the existing union; reuses `deterministicRecipe` for `attachedCard` + `quickActions`. Every failure (misconfigured / unavailable / malformed_response) is normalised to `DraftGeneratorError` so the service catches and the route returns a clean 500. | Swap for a streaming or provider-specific client without touching the route. | `pnpm test:draft-generator` |
| `channels/router.server.ts` | `POST /api/channels/mock`, `channels/mock-inbound.server.ts`, future provider adapters | Pure command router: normalised `CommandEvent` → `CommandResponse`. Keyword classifier today, no DB/LLM/queue, and compose responses return `needs_review` so the channel never claims execution. P8-G adds `reviewUrl` as a relative Keepsake pointer (`/people` for follow-up, `/workspace?...` for compose hints); adapters may render it as a link, but it is not an execution claim. | Future LLM classifier can sit behind the same function. | `pnpm test:channels` |
| `channels/mock-inbound.server.ts` | `POST /api/channels/mock/inbound` | DB-backed mock provider-adapter shape. Requires `KEEPSAKE_DATA_SOURCE=db`; validates `externalUserId` + `text`; resolves `(provider="mock", externalUserId)` via `workerTransaction` + `ChannelAccountRepository.findByProviderUser`; returns 200 `needs_link` for missing/revoked links with `reviewUrl: "/profile#command-channels"`; for active links delegates to `handleOwnerCommand(ownerId, event)` (P8-E) so the reply can reflect owner data. Does not read current user/session/dev owner and does not create drafts/enqueue/send. Dev-only response echoes `ownerId`; real providers must not. | WhatsApp / Telegram / Slack adapters add provider signature verification, dedupe, and payload normalisation before the same identity lookup + service handoff. | `pnpm test:db:channels-inbound`, `pnpm test:boundaries` |
| `channels/telegram.server.ts` | `POST /api/channels/telegram` | First real provider adapter (P8-H), plus `/start <token>` linking (P8-J). Validates Telegram's `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_WEBHOOK_SECRET`; requires DB mode, `TELEGRAM_BOT_TOKEN`, and `KEEPSAKE_APP_ORIGIN`; normalises text updates into `CommandEvent`; handles `/start <token>` before ordinary lookup by delegating to `telegram-start-token.server.ts`; otherwise resolves `(provider="telegram", message.from.id)` via `workerTransaction` + `ChannelAccountRepository.findByProviderUser`; returns/sends `needs_link` for missing or revoked rows; for active rows delegates to `handleOwnerCommand(ownerId, event)` and replies through Telegram Bot API `sendMessage` with an absolute Keepsake review URL. Does not read web sessions or `DEV_OWNER_*`, does not echo `ownerId`, and never creates drafts/enqueues deliveries/sends Gmail. | Add provider update-id dedupe, inline keyboards/callback queries, and outbound reminders as separate slices. WhatsApp/Slack should copy the same identity + service handoff shape. | `pnpm test:db:channels-telegram`, `pnpm test:boundaries` |
| `channels/telegram-start-token.server.ts` | `app/profile/page.tsx`, `channels/telegram.server.ts` | Stateless Telegram link token seam (P8-J). Profile calls `createTelegramStartLinkForOwner(ownerId)` to render `https://t.me/<TELEGRAM_BOT_USERNAME>?start=<token>`; token is ≤64 chars, expires after 15 minutes, and is HMAC-SHA256 signed with `APP_SESSION_SIGNING_SECRET` using a Telegram-specific context string. The Telegram adapter calls `linkTelegramAccountFromStartToken({ token, externalUserId, externalThreadId, displayName, rawProfile })`; valid tokens upsert `channel_accounts(provider="telegram")`, tampered/expired tokens produce a link-needed reply, and cross-owner conflicts return `already_linked` without rebinding. No DB token table, no session read in the webhook, no drafts/deliveries/Gmail. | Add one-time nonce persistence only if replay/idempotency requirements outgrow the current stateless token. | `pnpm test:db:channels-telegram`, `pnpm test:db:channel-profile` |
| `channels/command-service.server.ts` | `channels/mock-inbound.server.ts`, future provider adapters | Owner-scoped channel read path (P8-E). `handleOwnerCommand(ownerId, event)` calls `routeCommandEvent()` for intent. For `relationship_followup_query`, opens `transaction(ownerId, …)`, reads `PeopleRepository.listWithRelations`, filters upcoming occasions (`daysUntil ≥ 0 && ≤ 30`, top 3 ascending), and renders a real-name reply that still points the user back to Keepsake (`Open Keepsake to draft and send when you're ready`). Empty window resolves to "Nothing in the next 30 days…". Other intents pass through untouched, so `compose_request` keeps its `needs_review` status. Read-only on owner data — never creates a draft, enqueues a delivery, calls Gmail, touches `currentUser*`, or talks to a real provider. | Future LLM intent classifier slots in behind `routeCommandEvent` without changing this seam; future outbound reminders can call a sibling `handleOwnerReminder(ownerId, …)` sharing the same `transaction(ownerId, …)` shape. | `pnpm test:db:channels-inbound` |
| `channel-accounts/profile.server.ts` | `app/profile/page.tsx`, `POST /api/channels/mock/{link,revoke}`, `POST /api/channels/telegram/{link,revoke}` | Profile-facing channel management (P8-F/P8-I/P8-J). `getProfileChannelAccounts()` returns `{ dataSource: "mock"|"db", accounts, telegramStartLink }` — mock mode is an empty list (UI renders a placeholder; we don't fake rows). DB mode renders the signed Telegram start link when `TELEGRAM_BOT_USERNAME` + `APP_SESSION_SIGNING_SECRET` are configured, and keeps manual mock/Telegram forms as fallback/operator paths. `linkMockChannelAccount(input)`, `linkTelegramChannelAccount(input)`, and `revokeChannelAccount(input)` are DB-mode only (mock → 501 `not_configured`) and resolve the caller with `currentUserIdOrThrow()` BEFORE any DB call (no sessionless mutation). Transaction model: list + revoke use `transaction(ownerId, …)` (RLS-backed, request-path pool); link delegates to `ChannelAccountRepository.link`, whose runtime elevates to `workerTransaction` for atomic cross-owner conflict detection on the unique `(provider, external_user_id)` index — owner_id is enforced in SQL via `ON CONFLICT … DO UPDATE … WHERE owner_id = $caller`. Maps repo `cross_owner_conflict` → 409, unknown / cross-owner revoke → 404; unexpected errors are logged via `console.error` and surfaced with a generic detail. Never touches a draft, delivery queue, Gmail, or any real provider. | WhatsApp / Slack link UI remains future; Telegram manual fallback can be removed later if `/start` proves enough. | `pnpm test:profile` (mock placeholder), `pnpm test:db:channel-profile` (DB link/revoke round-trip + start-link render + cross-owner + inbound integration + no-session 401) |

The `app/` tree should not import `lib/mock.ts` directly. If a page needs
server data, make the page a server component and call one of these helpers,
passing serializable domain payloads down to client components. If a client
component needs live data, fetch an API route.

### Current OAuth + Gmail account routes

Gmail OAuth start + callback are fully implemented behind the seam, along
with a Profile-facing disconnect route:

```text
GET  /api/oauth/gmail/start
GET  /api/oauth/gmail/callback
POST /api/gmail/disconnect
```

App session sign-out is a separate, thinner route — it only tears down
the `keepsake_session` cookie:

```text
POST /api/auth/signout
```

`/api/auth/signout` does NOT touch the Gmail sender (still owned by
`POST /api/gmail/disconnect`) and does NOT revoke the Google OAuth
grant (out of scope for this slice). It reads no DB. The response is
always 303; the default destination is `/signin`, an optional
`?returnTo=` is routed through the shared `safeReturnTo()` with a
`/signin` fallback for unsafe input.

`POST /api/gmail/disconnect` is a thin route: `currentUserIdOrThrow()` →
`disconnectGmailAccount(ownerId, origin)` from
`gmail-account/disconnect.server.ts` → `303` to `/profile`. The helper looks
up the primary row through `GmailAccountRepository.getPrimary(ownerId)` and,
if present, removes it through `GmailAccountRepository.disconnect`. Missing
rows (mock mode or already-disconnected) return success rather than 404 so
the form is safe to re-submit.

Both routes are `force-dynamic`. They authenticate through
`currentUserIdOrThrow()`, delegate to `oauth/gmail.server.ts`, and apply any
plain-data redirect/cookie instructions returned by the seam:

- missing dev auth → `401 { error: "Unauthenticated" }`
- invalid dev auth → `500 { error: "Auth is misconfigured" }`
- missing any required env (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_REDIRECT_URI`, `OAUTH_STATE_SIGNING_SECRET` ≥ 32 chars) →
  `501 { code: "not_configured", ... }`
- start, fully configured → `307` to Google + HttpOnly state cookie carrying
  HMAC-signed `{ ownerId, returnTo, state, issuedAt }`
- callback with provider `error` → `400 { code: "provider_error", ... }` + clear cookie
- callback missing `code`/`state` → `400 { code: "invalid_callback", ... }` + clear cookie
- callback with missing/bad/expired/owner-mismatched/state-mismatched cookie →
  `400 { code: "invalid_callback", ... }` + clear cookie
- callback with valid state but `GOOGLE_TOKEN_ENDPOINT` returning non-OK, no
  refresh_token, no id_token, or no email claim → `400 { code: "invalid_callback", ... }`
  + clear cookie
- callback success → `307` to the cookie's safe `returnTo`, `gmail_accounts`
  primary row upserted with encrypted refresh-token metadata, state cookie cleared

The seam owns: HMAC sign/verify, state TTL, owner check, scope construction,
token exchange via native `fetch`, id_token email extraction, and the short
write transaction. Route handlers never read SQL, never see plaintext tokens,
and never decide what to set or clear in the cookie. Token exchange runs
outside the DB transaction; only the repo write is wrapped in
`transaction(ownerId, ...)`.

`GOOGLE_TOKEN_ENDPOINT` defaults to `https://oauth2.googleapis.com/token`.
Tests override it to a local fake server so no traffic ever reaches Google.

### Current DB runtime skeleton

`db/transaction.server.ts` is now the request-path DB entrypoint:

```ts
await transaction(ownerId, async (tx) => {
  // repository calls go here later
});
```

The helper opens one Postgres transaction from the module-level `pg.Pool`,
sets the caller context with `SET LOCAL app.user_id = ...`, then commits or
rolls back before releasing the connection. The pool connection string comes
from `DATABASE_URL`.

`db/transaction.server.ts` also exports `query(tx, text, values)` for future
`lib/repositories/*.server.ts` implementations. That is still server-only
plumbing: route handlers, pages, and components should not write SQL or hold
pg clients directly.

The request role must be the app role: granted only the normal table
privileges it needs, with Row-Level Security doing the ownership filtering,
and no `BYPASSRLS`. `ownerId === null` is deliberately fail-closed: the
helper sets `app.user_id` to the empty string, `current_user_id()` returns
`NULL`, and per-user policies see no rows.

`/api/people`, Home + People + Workspace + History (through `remaster-overview`), `/api/drafts`,
`/api/drafts/versions`, and delivery-history reads can now reach this DB layer when
`KEEPSAKE_DATA_SOURCE=db`. The underlying People schema and `/api/people`
contract are still person-centered; Workspace framing has migrated while the
draft/send route contracts remain person/occasion-centered, and History framing
has migrated while delivery storage/webhook/worker contracts remain legacy. The default remains mock so local UI work does not
require Postgres. Draft generation is now mock/provider-swappable behind
`KEEPSAKE_DRAFT_SOURCE` (default `mock`, opt-in `openai`); the route
contract is unchanged.

For `/api/drafts`, the route remains deliberately thin: parse the JSON body,
call `generateDraft(input)`, then return its `MessageDraft`. The default mock
branch preserves the old resolver + mock generator path and does not write
DB rows. The DB branch resolves context, computes a stable prompt HMAC from
server-side inputs plus `userInstruction` and the active generator's
`modelProvider` / `modelVersion`, checks `message_drafts`, and saves cache
misses. Folding the generator identity into the hash means switching from
`mock` to `openai` cleanly invalidates cached drafts. The client contract is
still only `{ personId, occasionId, userInstruction }`; relationship,
cultureRule, and tone are server-authoritative and are never read from
client overrides. When `KEEPSAKE_DRAFT_SOURCE=openai` is set without
`KEEPSAKE_DRAFT_API_KEY`, the seam raises `DraftGeneratorError("misconfigured", …)`
which the service layer maps to a 500 with a clean `{ error }` message —
mock is never silently substituted.

The same route now supports latest-draft restore with
`GET /api/drafts?personId=...&occasionId=...`. The route reads query params,
calls `getLatestDraft(input)`, and returns either a `MessageDraft` JSON body
or 204 when no draft exists. In default mock mode this is always a miss. In
DB mode the service opens one owner-scoped transaction, validates the person
and occasion through `resolveDbDraftContextInTx`, then calls
`DraftRepository.getLatestFor`. A supplied `occasionId` must belong to the
person; an omitted `occasionId` falls back to `person.nextOccasionId`, or to
the `NULL` occasion bucket when no next occasion exists.

Draft version history lives at
`GET /api/drafts/versions?personId=...&occasionId=...&limit=...`. The route
only parses query params and calls `listDraftVersions(input)`. In mock mode it
returns `{ drafts: [] }`. In DB mode the service opens the same owner-scoped
transaction, validates person/occasion ownership through
`resolveDbDraftContextInTx`, reads recent drafts with
`DraftRepository.listForPerson`, filters to the resolved occasion, and returns
newest-first drafts up to the safe limit. The Workspace compose header uses
that read path for its compact version strip; clicking a version only changes
local display state and never saves, sends, enqueues, or calls webhook/worker
code.

For History, the page remains a server component that calls
`getRemasterHistoryCompatibilityView()`. That compatibility view calls
`getDeliveryHistory()` internally and pairs the existing `Delivery[]` rows with
the derived account/contact/activity overview. In DB mode the delivery-history
helper opens a user-scoped transaction and returns decrypted `Delivery[]` rows
from `DeliveryRepository.listByMonth(ownerId, { limit: 50 })`. The History page
is still read-only: enqueue, worker, provider webhook, and send contracts stay
behind their existing seams.

`DeliveryRepository` now has runtime implementations for every method in
the interface: `listByMonth` (History read), `enqueue` (queue boundary),
plus the worker-only `nextQueued` (FOR UPDATE SKIP LOCKED queued email
rows, with decrypted recipient fields), `markStatus` (idempotent +
monotonic UPDATE — sets `sent_at` on first `sent`, COALESCEs
`provider_message_id`), `findByProviderMessageId` (webhook ingest ready,
no consumer wired yet), and **`requeueStaleSending(seconds)`** (P5-B
stale recovery — `UPDATE … SET status='queued', provider_message_id=NULL
WHERE status='sending' AND updated_at < now() - make_interval(secs => $1)`).
The worker plumbing requires a connection with `BYPASSRLS` —
`KEEPSAKE_WORKER_DATABASE_URL` defaults to `DATABASE_URL`. There is no
retry queue, webhook route, or daemon in this slice; the bounded
`runWorkerLoop` is the operator primitive that whatever-the-operator-uses
calls from outside.

### Service contracts

### `auth/current-user.server.ts`

**Purpose.** Resolve the authenticated current user and owner id. Today this
is a dev-only seam that reads `DEV_OWNER_ID`, `DEV_OWNER_EMAIL`, and
`DEV_OWNER_NAME`; later it becomes the only place in the codebase that reads
cookies / `Authorization` headers and verifies session or OAuth tokens.

**Current surface.**

```ts
export interface CurrentUser {
  readonly id: OwnerId;
  readonly email: string;
  readonly name: string;
  readonly initials: string;
  readonly sendingAccount: SendingAccount | null;
}

export interface SendingAccount {
  readonly provider: "gmail";
  readonly email: string;
  readonly status: "connected" | "expired";
}

export class AuthError extends Error {
  readonly kind: "unauthenticated" | "misconfigured";
}

export function currentUserOrThrow(): Promise<CurrentUser>;
export function currentUserIdOrThrow(): OwnerId;
```

`DEV_OWNER_ID` must be a UUID, `DEV_OWNER_EMAIL` must pass the basic email
guard, and `DEV_OWNER_NAME` must be non-empty. `sendingAccount` is `null`
until a Gmail OAuth/account lookup exists. Missing `DEV_OWNER_ID` throws
`AuthError { kind: "unauthenticated" }`; invalid owner env throws
`AuthError { kind: "misconfigured" }`. In mock mode `sendingAccount` stays
`null`. In DB mode `currentUserOrThrow()` reads the owner's primary
`gmail_accounts` row through `GmailAccountRepository.getPrimary()` and maps it
to `{ provider: "gmail", email, status }`; missing rows still map to `null`.
`currentUserIdOrThrow()` intentionally remains synchronous and never performs
the Gmail account lookup.

`pnpm env:init` runs `scripts/init-dev-env.mjs` to create `.env.local` from
`.env.example`; it refuses to overwrite an existing `.env.local` unless
`--force` is passed. `pnpm dev` then runs `scripts/check-dev-env.mjs` before
`next dev` so missing dev-only auth values fail with a clear setup message
instead of a rendered 500 in Home/Profile. In mock mode the guard checks only
`DEV_OWNER_*`; in DB mode it also checks `DATABASE_URL` and a 32-byte
`DEV_ENCRYPTION_KEY_BASE64`. `.env.example` remains documentation only for
the preflight.

**Where called.** DB-backed server helpers continue to call
`currentUserIdOrThrow()` so their signatures stay compatible. The public
session route, `GET /api/session`, calls `currentUserOrThrow()` and returns
`{ user }`, mapping unauthenticated to 401 and misconfigured env to 500.
Home, Workspace, and Profile also call `currentUserOrThrow()` server-side to
render the same identity shape without a client fetch. Workspace passes that
shape into the client composer as read-only sender identity; when
`sendingAccount` is `null`, it explicitly shows that no sender is configured.
Profile uses the same field to avoid showing a fake connected state. This does
not wire Google OAuth, provider SDKs, send/enqueue, or delivery worker paths.
Only the full current-user helper performs the DB read in DB mode; the owner-id
helper used by repository-backed seams remains a cheap env validation helper.

**Provider choices to make later.** NextAuth / Auth.js vs. roll-our-own
session table vs. Clerk / Supabase Auth. Decision deferred; the
route contract stays provider-agnostic because only this auth service changes.

### `db/transaction.server.ts`

**Purpose.** Hand out a `Tx` (the opaque handle declared in
[`lib/repositories/types.ts`](../repositories/types.ts)) tied to a single
connection. Sets `app.user_id` via `SET LOCAL` at transaction open time;
the connection is returned to the pool on commit/rollback.

**Likely surface.**

```ts
export function transaction<T>(
  ownerId: OwnerId | null,                      // null = anonymous (no RLS bypass!)
  fn: (tx: Tx) => Promise<T>,
): Promise<T>;
```

**Where called.** Route handlers that compose multiple repository calls
(see [`lib/repositories/README.md`](../repositories/README.md#current-apidrafts-db-mode-walkthrough)
for the `/api/drafts` shape). One-shot reads skip it — the repo opens its
own implicit transaction when `tx` is omitted.

**Hard rules.**
- The pool role is the app role: `NOLOGIN` to the public, no `BYPASSRLS`.
- `SET LOCAL`, not `SET` — transaction-scoped so PgBouncer transaction
  pooling stays safe.
- If `ownerId` is `null`, `SET LOCAL app.user_id = ''`; the RLS helper
  returns NULL and every per-user policy fails closed.
- The worker role (drains `deliveries.status = 'queued'`) has its own
  service — `db/worker-transaction.server.ts`, not modelled here. Request
  handlers must never reach for it.

### `crypto/envelope.server.ts`

**Purpose.** Encrypt and decrypt the columns marked `🔒` in
[`db/schema.sql`](../../db/schema.sql). The repositories are the only
callers; nothing else in the codebase needs to know an envelope exists.

**Current dev surface.**

```ts
export function encrypt(ownerId: OwnerId, table: string, column: string, plaintext: Uint8Array): Promise<Uint8Array>;
export function decrypt(ownerId: OwnerId, table: string, column: string, envelope: Uint8Array): Promise<Uint8Array>;
```

The current implementation is development-only. It reads one 32-byte
base64 key from `DEV_ENCRYPTION_KEY_BASE64`; it does not touch KMS or
`user_keys` yet. `pnpm test:crypto` verifies roundtrip, AAD mismatch, and
ciphertext tampering.

**Where called.** Inside `*.server.ts` repo implementations, never from a
route handler directly. Current callers include people, drafts, and delivery
history repositories.

**Design points.**
- AES-256-GCM, 12-byte nonce, 16-byte tag. Envelope = `nonce ‖ ct ‖ tag`.
- `AAD = ownerId | table | column`. Copying ciphertext between rows or
  columns fails to decrypt.
- Future production pass: per-user DEK lives in `user_keys`, wrapped by a
  KMS-held KEK. At that point this module grows a key-provider layer and
  per-request cache; callers should keep using the same encrypt/decrypt
  boundary.

### `draft-generator/`

**Purpose.** Turn `{ person, relationship, culture, occasion, userInstruction }`
into the fields a `MessageDraft` needs. Two implementations of the same
`DraftGenerator` interface ship today: the mock heuristic generator
(`mock.server.ts`) and an OpenAI-compatible LLM adapter
(`openai.server.ts`). `index.server.ts` picks between them at runtime.

**Current surface.**

```ts
export interface DraftContext {
  person: Person;
  relationship: Relationship;
  cultureRule: CultureRule;
  occasion: OccasionNode | null;
  userInstruction: string;          // "" → initial draft
}

export interface DraftGenerator {
  readonly modelProvider: string;   // "mock" | "openai"
  readonly modelVersion: string;    // e.g. "mock-draft-generator:v1" | "openai:gpt-4o-mini"
  generate(input: DraftContext): Promise<MessageDraft>;
}

export class DraftGeneratorError extends Error {
  readonly kind: "misconfigured" | "unavailable" | "malformed_response";
}

export function getDraftGenerator(): DraftGenerator;
```

`KEEPSAKE_DRAFT_SOURCE` chooses the backend (`mock` default, `openai`
opt-in). It is deliberately independent of `KEEPSAKE_DATA_SOURCE`. The
OpenAI adapter additionally requires `KEEPSAKE_DRAFT_API_KEY` and reads
`KEEPSAKE_DRAFT_API_BASE` (default `https://api.openai.com/v1`) and
`KEEPSAKE_DRAFT_MODEL` (default `gpt-4o-mini`). Missing env throws
`DraftGeneratorError("misconfigured", …)`; the seam never silently falls
back to mock.

**Where called.** Only `/api/drafts` POST, through `draft-service`.
Composed alongside
`PeopleRepository.findById`, `CatalogRepository.getRelationship/getCulture`,
`DraftRepository.findByPromptHash`, `DraftRepository.save`.

**Why this lives in `lib/server/`, not `lib/repositories/`.** The repo
layer persists; this layer thinks. Each generator implements the same
`DraftGenerator` interface — the route handler doesn't care which one is
wired.

**LLM contract scope.** The model owns `tone`, `toneLabel`, `subject`,
`paragraphs`, and `assistantNote`. `attachedCard` and `quickActions` come
from the deterministic recipe in `mock.server.ts` (`deterministicRecipe`),
because the model isn't trusted to round-trip our presentation hints yet.
The system prompt locks `tone` to the existing union; any unsupported
value, missing field, or non-JSON output is normalised to
`DraftGeneratorError("malformed_response", …)` and surfaces as a generic
500 to the client.

**Provenance + caching.** The repository save input carries `modelProvider`,
`modelVersion`, and `promptHash`. `draft-service/db.server.ts` reads
`modelProvider` / `modelVersion` from the active generator and folds them
into the prompt-input HMAC, so switching `KEEPSAKE_DRAFT_SOURCE` invalidates
previously cached drafts automatically. The public draft returned to the UI
is still the `MessageDraft` shape.

## How these compose at the `/api/drafts` route

Default mock mode:

```
app/api/drafts/route.ts
  ├─ POST → draft-service/index.server.ts
  │          └─ mock.server.ts
  │             ├─ draft-context/mock.server.ts
  │             └─ draft-generator/mock.server.ts
  └─ GET  → draft-service/index.server.ts
             └─ mock.server.ts → draft:null

app/api/drafts/versions/route.ts
  └─ GET  → draft-service/index.server.ts
             └─ mock.server.ts → drafts:[]
```

No DB writes happen in this branch.

DB mode:

```
POST /api/drafts
  │
  ├─ draft-service/db.server
  ├─ auth/current-user             → OwnerId
  ├─ db/transaction                ┐ opens a tx, SET LOCAL app.user_id
  │                                │
  │   ├─ draft-context/db.server    │ validate + hydrate context
  │   ├─ PeopleRepository           │ findById, findOccasionForPerson
  │   ├─ CatalogRepository          │ getRelationship, getCulture
  │   ├─ DraftRepository            │ findByPromptHash
  │   ├─ draft-generator/mock        │ generate(...) on cache miss
  │   └─ DraftRepository            │ save(...) on cache miss
  │                                ┘
  └─ crypto/envelope                used inside every repo *.server.ts; the route handler never sees it
```

The client still sends only `{ personId, occasionId, userInstruction }`.
`relationship` and `cultureRule` are resolved server-side from
`person.relationshipId` / `person.cultureId`. Anything that looks like a
client trying to specify a culture or relationship is ignored by this service
and is not part of the prompt HMAC. DB mode now persists and caches
`message_drafts`; LLM generation is still future work.

```
GET /api/drafts?personId=...&occasionId=...
  │
  ├─ draft-service/db.server
  ├─ auth/current-user             → OwnerId
  ├─ db/transaction                ┐ opens a tx, SET LOCAL app.user_id
  │                                │
  │   ├─ draft-context/db.server    │ validate person + occasion ownership
  │   ├─ PeopleRepository           │ findById, findOccasionForPerson
  │   ├─ CatalogRepository          │ getRelationship, getCulture
  │   └─ DraftRepository            │ getLatestFor(ownerId, personId, occasionId)
  │                                ┘
  └─ crypto/envelope                decrypts the restored MessageDraft inside the repo
```

Workspace uses this GET first when the person/occasion is known. A 200 restores
the saved draft into the compose view; a 204 miss falls back to
`POST /api/drafts` with an empty `userInstruction` to generate the initial
mock draft. Send, enqueue, webhooks, workers, and the LLM-backed generator
remain future work.

```
GET /api/drafts/versions?personId=...&occasionId=...&limit=...
  │
  ├─ draft-service/db.server
  ├─ auth/current-user             → OwnerId
  ├─ db/transaction                ┐ opens a tx, SET LOCAL app.user_id
  │                                │
  │   ├─ draft-context/db.server    │ validate person + occasion ownership
  │   ├─ PeopleRepository           │ findById, findOccasionForPerson
  │   ├─ CatalogRepository          │ getRelationship, getCulture
  │   └─ DraftRepository            │ listForPerson(ownerId, personId, readLimit)
  │                                ┘
  └─ crypto/envelope                decrypts each MessageDraft inside the repo
```

Workspace refreshes this list after initial restore/generation and after each
successful draft request. The UI shows at most five compact version chips
when more than one saved draft exists. Selecting an older chip is a read-only
preview/rollback in local compose state; it does not create another
`message_drafts` row.

## How these compose at the History page

```
app/history/page.tsx
  │
  ├─ remaster-overview/index.server.ts
  │   ├─ people-payload/index.server.ts
  │   ├─ delivery-history/index.server.ts
  │   │   ├─ mock.server.ts  → lib/mock.ts deliveries          (default)
  │   │   └─ db.server.ts    → auth/current-user
  │   │                         db/transaction
  │   │                         DeliveryRepository.listByMonth (KEEPSAKE_DATA_SOURCE=db)
  │   └─ lib/remaster/read-model.ts → derived Account / Contact / Activity view
  │
  └─ render History activity timeline from Delivery[] + compatibility overview
```

The DB branch is intentionally only a read path over sent deliveries.
`app/history/page.tsx` does not import repositories, SQL helpers, mock data, or
the delivery-history dispatcher directly. The future `DeliveryRepository.enqueue`, `markStatus`,
`findByProviderMessageId`, and `nextQueued` methods still throw in the
runtime implementation; send buttons, provider webhooks, and worker drain
logic are not wired.

## Open questions

1. **AsyncLocalStorage everywhere?** Per-request DEK cache, per-request
   `OwnerId`, per-request OpenTelemetry span. The temptation is to
   bundle these into one context object. Probably fine; revisit when
   the implementations land.
2. **Where does the prompt template live?** Inside `draft-generator/`,
   probably as a `templates/` subdirectory keyed by `OccasionKind` ×
   `RelationshipKind` × `CultureId`. Out of scope for this design pass.
3. **Worker process vs. request handler.** `db/worker-transaction.server.ts`
   needs the worker role; we'll add it when the send queue ships.
4. **Crypto production key provider.** The current envelope helper is
   dev-only and reads `DEV_ENCRYPTION_KEY_BASE64`. Production still needs a
   KMS-backed key provider, per-user DEK loading from `user_keys`, rotation
   history, and request-local caching.
