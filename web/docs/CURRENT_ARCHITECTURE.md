# Keepsake / ReMaster — current architecture map

A snapshot of how the codebase looks today, for handing work between Claude
Code, Codex, and humans without re-deriving the layering each time. Pairs
with [`docs/DB_SCHEMA.md`](./DB_SCHEMA.md) (target schema) and the four READMEs
under [`lib/repositories/`](../lib/repositories/README.md), [`lib/server/`](../lib/server/README.md), [`db/`](../db/README.md).

This document is descriptive. When the codebase moves, this file moves
with it. When in doubt, the code wins.

> **ReMaster pivot note**
> - The live runtime described here is still centered on `Person`,
>   `OccasionNode`, drafts, and deliveries.
> - The planned product evolution is centered on `Account`, `Contact`,
>   stakeholder role, and `ActivityEvent`.
> - This file stays descriptive of current code. The forward model blueprint
>   lives in [`docs/REMASTER_MODEL.md`](./REMASTER_MODEL.md).

---

## 1. Current request flows

### `GET /api/people`

```
client                    server
  │                         │
  │  GET /api/people        │
  ├────────────────────────►│
  │                         │  app/api/people/route.ts
  │                         │      │
  │                         │      ▼
  │                         │  lib/server/people-payload/index.server.ts
  │                         │      │  getPeoplePayload()
  │                         │      ├─ KEEPSAKE_DATA_SOURCE unset/mock
  │                         │      │    ▼
  │                         │      │  people-payload/mock.server.ts → lib/mock.ts
  │                         │      │
  │                         │      └─ KEEPSAKE_DATA_SOURCE=db
  │                         │           ▼
  │                         │         auth/current-user.server.ts
  │                         │           ▼
  │                         │         db/transaction.server.ts
  │                         │           ▼
  │                         │         PeopleRepository.listWithRelations(ownerId)
  │                         │      ▼
  │  ◄──── PeoplePayload ───┤  NextResponse.json({...})
  │                         │
```

Route is `force-dynamic` because DB mode is user-scoped. Default local/runtime
source is still mock unless `KEEPSAKE_DATA_SOURCE=db` is set.

### `GET /api/session`

```
client                    server
  │                         │
  │  GET /api/session       │
  ├────────────────────────►│
  │                         │  app/api/session/route.ts
  │                         │      │
  │                         │      ▼
  │                         │  lib/server/auth/current-user.server.ts
  │                         │      │  currentUserOrThrow()
  │                         │      ▼
  │  ◄──── { user } ────────┤  200 NextResponse.json({ user })
  │  ◄──── { error } ───────┤  401 missing auth, 500 invalid dev env
  │                         │
```

This is the stable public session contract.

`lib/server/auth/current-user.server.ts` now resolves identity in this
order:

1. **App session cookie** (`keepsake_session`). The cookie is a
   signed `<base64url payload>.<base64url sig>` produced by
   `lib/server/auth/session.server.ts` (HMAC-SHA256 over the payload,
   secret = `APP_SESSION_SIGNING_SECRET`, min 32 chars, default TTL
   24h). Successful verification yields `{ ownerId, email, name }`.
2. **`DEV_OWNER_*` env fallback** when NO cookie is present. This is
   the transitional bridge that keeps local dev + the existing smoke
   suite runnable while real sign-in lands later.

**A cookie that is present but invalid (signature, expiry, malformed
payload) is NEVER silently downgraded to env fallback.** It returns
401 `Unauthenticated`. The signing secret being absent while a cookie
is present is `Auth is misconfigured` (500).

### `/signin` page and page-level redirects

After P6-C, every "inside the product" page (`/`, `/people`,
`/workspace`, `/history`, `/profile`) calls a stricter helper —
`requireSessionUserOrRedirect(currentPath)` from
`lib/server/auth/require-session.server.ts` — instead of the
cookie-first-with-env-fallback `currentUserOrThrow()`. The helper:

1. calls `currentSessionUserOrThrow()` (cookie-only — no `DEV_OWNER_*`
   fallback);
2. on `AuthError("unauthenticated", …)` `redirect()`s to
   `/signin?returnTo=<currentPath>`;
3. on `AuthError("misconfigured", …)` re-raises so Next surfaces a
   500 — a deployment break is NOT masked as a sign-in prompt.

`/signin` (`app/signin/page.tsx`) is a server component. It calls
`currentSessionUserOrThrow()` itself: visitors who already have a
valid `keepsake_session` are 307-redirected to `returnTo` (default
`/`). Unauthenticated visitors see a minimal page with one CTA:

- **Continue with Google** — `<a href="/api/auth/google/start?returnTo=…">`.
- When `ENABLE_DEV_SESSION_ROUTES=1` is set, a second
  **Continue as dev owner** form posts to
  `/api/auth/dev-session/start?returnTo=…`. The dev-session route
  was extended this slice: when `returnTo` is present in the query,
  the response is 303 to that path (with the session cookie
  attached); without it, the historical 200 + JSON receipt is
  preserved.

`returnTo` is uniformly validated as a strict relative path
(`/foo/bar` ok, `//evil.example`, `https://…`, anything that isn't
a leading `/`-prefixed non-double-slash path is rejected). Invalid
values fall back to `/` (or, for sign-out, to `/signin` — see
below). The 5 product pages each declare their own `returnTo`
string so the post-sign-in redirect lands the user back on the
exact view they tried to open (workspace preserves `?person=…`).

### Sign-out

`POST /api/auth/signout` (`app/api/auth/signout/route.ts`) closes
the loop: it clears `keepsake_session` (`Max-Age=0`) and 303s to
`/signin` (or to a safe relative `?returnTo=…`; unsafe values fall
back to `/signin`, NOT to `/`). The route deliberately does NOT
read the current user, touch the DB, revoke the Google OAuth
grant, or disconnect Gmail. Gmail sender disconnect remains its
own slice at `POST /api/gmail/disconnect`; Google revoke is not
in scope yet.

Profile's "Sign out" row is now a real `<form method="post" action="/api/auth/signout">`
with a single submit button (no client component, no modal). The
form lives at the bottom of the ACCOUNT section in
`app/profile/page.tsx`.

`currentUserOrThrow()` is deliberately unchanged: routes, API
handlers, and server seams still get cookie-first behaviour with
`DEV_OWNER_*` fallback so the existing smoke suite + local dev
continue to work without a sign-in step. The split is intentional:
the **page** layer is strict; the **machine** layer is permissive
until the env fallback is retired in a later slice.

`/api/auth/google/start` (GET) and `/api/auth/google/callback` (GET)
are the real **Google identity sign-in transport** (P6-B). This is a
SEPARATE OAuth flow from `lib/server/oauth/gmail.server.ts` — that flow
asks Google for `gmail.send` and persists into `gmail_accounts`; this
flow asks Google for `openid email profile`, never touches
`gmail_accounts`, and on success: (a) finds-or-creates a `users` row on
the verified email, (b) issues a `keepsake_session` cookie, (c) clears
the auth state cookie, (d) 307s to the request's `returnTo` (default
`/`). Configuration env: `KEEPSAKE_AUTH_GOOGLE_CLIENT_ID` /
`_SECRET` / `_REDIRECT_URI` (state cookie reuses
`OAUTH_STATE_SIGNING_SECRET`). 501 `not_configured` if env missing
OR if `KEEPSAKE_DATA_SOURCE !== "db"` (no DB means no users row).
400 `invalid_callback` / `provider_error` follow the same shape as
the Gmail OAuth flow; every callback response (success or failure)
clears the auth state cookie.

`/api/auth/dev-session/start` (POST) and `/api/auth/dev-session/clear`
(POST) are minimal dev/test bootstrap routes. **Both are gated behind
`ENABLE_DEV_SESSION_ROUTES=1`** and return 404 when the flag is unset
so they cannot be exercised in production / staging deployments. When
enabled: `start` reads identity STRICTLY from `DEV_OWNER_*` env via
`devOwnerFromEnvOrThrow()` (never consulting any existing cookie, so a
tampered cookie can't block bootstrap and a stale-but-valid cookie
can't deflect identity), mints a fresh session cookie, and returns the
same `{ user }` shape as `/api/session`. `clear` issues a `Max-Age=0`
cookie. They are not a sign-in product.

Public contract is unchanged: `{ user }` on success; 401 / 500 stay
the same. `currentUserIdOrThrow()` is now `async` (it must read the
cookie via `next/headers`); every call site is already in an async
chain — see `git log` for the one-line migrations across the
routes / server seams.

### `GET /api/oauth/gmail/start` and `GET /api/oauth/gmail/callback`

```
client                    server
  │                         │
  │  GET /api/oauth/gmail/start
  ├────────────────────────►│
  │                         │  app/api/oauth/gmail/start/route.ts
  │                         │      ├─ auth/current-user.server.ts
  │                         │      │    currentUserIdOrThrow()
  │                         │      ▼
  │                         │  lib/server/oauth/gmail.server.ts
  │                         │      │  build authorization URL
  │                         │      │  + HMAC-sign state cookie
  │  ◄── 307 + Set-Cookie ──┤  Location: accounts.google.com/o/oauth2/v2/auth
  │                         │
  │  GET /api/oauth/gmail/callback?code=...&state=...     [carries cookie]
  ├────────────────────────►│
  │                         │  app/api/oauth/gmail/callback/route.ts
  │                         │      ├─ auth/current-user.server.ts
  │                         │      │    currentUserIdOrThrow()
  │                         │      ├─ read keepsake_gmail_oauth_state cookie
  │                         │      ▼
  │                         │  lib/server/oauth/gmail.server.ts
  │                         │      │  verify HMAC + TTL + owner + state
  │                         │      │  fetch GOOGLE_TOKEN_ENDPOINT (native fetch)
  │                         │      │  extract email from id_token
  │                         │      ▼
  │                         │  db/transaction.server.ts (short)
  │                         │      ▼
  │                         │  GmailAccountRepository.upsertPrimary(...)
  │  ◄── 307 + clear cookie ┤  Location: <payload.returnTo on origin>
  │                         │
  │  ◄── 400 + clear cookie ┤  any validation/exchange failure
  │  ◄── 501 ───────────────┤  any of 4 OAuth env vars missing
  │                         │
  │  POST /api/gmail/disconnect          [Profile form submission]
  ├────────────────────────►│
  │                         │  app/api/gmail/disconnect/route.ts
  │                         │      ├─ auth/current-user.server.ts
  │                         │      │    currentUserIdOrThrow()
  │                         │      ▼
  │                         │  lib/server/gmail-account/disconnect.server.ts
  │                         │      │  getPrimary → if exists,
  │                         │      │  transaction(ownerId) → repo.disconnect
  │  ◄── 303 ───────────────┤  Location: /profile (idempotent; mock no-op)
```

The seam reads `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`,
and `OAUTH_STATE_SIGNING_SECRET` (>=32 chars). All four required to leave
`not_configured`. Scopes requested: `openid email gmail.send` — the identity
pair is the smallest officially-supported way to learn the authorizing user's
verified email; no extra Gmail capability is acquired beyond send.

The state cookie carries `{ ownerId, returnTo, state, issuedAt }`, HMAC-SHA256
signed with `OAUTH_STATE_SIGNING_SECRET`, HttpOnly, SameSite=Lax, Path=/, with
a 10-minute TTL. The cookie is cleared on every callback response, success or
failure. Token exchange uses native `fetch` against `GOOGLE_TOKEN_ENDPOINT`
(default `https://oauth2.googleapis.com/token`; tests point this at a local
fake server). The DB transaction is opened only after token exchange returns
to keep network calls outside the transaction; the plaintext refresh token
only crosses the repository write boundary and is encrypted before insert.
The seam never sends mail or enqueues anything.

### `POST /api/drafts`

```
client                    server
  │                         │
  │  POST /api/drafts       │
  │  { personId, occasionId, userInstruction }
  ├────────────────────────►│
  │                         │  app/api/drafts/route.ts
  │                         │      │   1. await req.json()
  │                         │      │
  │                         │      ▼
  │                         │  lib/server/draft-service/index.server.ts
  │                         │      ├─ KEEPSAKE_DATA_SOURCE unset/mock
  │                         │      │    ▼
  │                         │      │  draft-context/mock.server.ts
  │                         │      │  draft-generator/index.server.ts → mock | openai
  │                         │      │
  │                         │      └─ KEEPSAKE_DATA_SOURCE=db
  │                         │           ▼
  │                         │         auth/current-user.server.ts
  │                         │           ▼
  │                         │         draft-generator/index.server.ts → mock | openai
  │                         │           ▼
  │                         │         db/transaction.server.ts
  │                         │           ▼
  │                         │         draft-context/db.server.ts
  │                         │           ▼
  │                         │         DraftRepository.findByPromptHash(ownerId, hash)
  │                         │           ├─ hit  → return cached MessageDraft
  │                         │           └─ miss → draft-generator.generate(ctx)
  │                         │                    DraftRepository.save(ownerId, draft)
  │                         │      ▼
  │  ◄──── MessageDraft ────┤  NextResponse.json(draft)
  │                         │
```

Route is `force-dynamic`. The generator picks mock or LLM through a separate
env switch, `KEEPSAKE_DRAFT_SOURCE` (defaults to `mock`, accepts `openai`);
it is independent of `KEEPSAKE_DATA_SOURCE`. The draft context is still
resolved server-side from `personId` / `occasionId` / `userInstruction` —
the client cannot override `relationship`, `cultureRule`, or `tone`. Default
mock mode is unchanged and does not write DB rows. DB mode resolves context
under RLS, computes a server-side prompt HMAC that folds in
`modelProvider` / `modelVersion` (so swapping providers invalidates the
cache), caches in `message_drafts`, and returns the persisted row id. When
`KEEPSAKE_DRAFT_SOURCE=openai` is set without `KEEPSAKE_DRAFT_API_KEY`, the
seam throws `DraftGeneratorError("misconfigured", …)` and the route returns
a 500 with `{ error: "Draft generator is misconfigured" }` — there is no
silent fallback to mock. Provider call failures and malformed provider
responses follow the same shape (`"… unavailable"` / `"… returned an
unusable response"`); provider URLs and stack traces are never sent to the
client.

### `GET /api/drafts`

```
client                    server
  │                         │
  │  GET /api/drafts?personId=...&occasionId=...
  ├────────────────────────►│
  │                         │  app/api/drafts/route.ts
  │                         │      │   1. read query params
  │                         │      │
  │                         │      ▼
  │                         │  lib/server/draft-service/index.server.ts
  │                         │      ├─ KEEPSAKE_DATA_SOURCE unset/mock
  │                         │      │    ▼
  │                         │      │  return draft:null
  │                         │      │
  │                         │      └─ KEEPSAKE_DATA_SOURCE=db
  │                         │           ▼
  │                         │         auth/current-user.server.ts
  │                         │           ▼
  │                         │         db/transaction.server.ts
  │                         │           ▼
  │                         │         draft-context/db.server.ts
  │                         │           ▼
  │                         │         DraftRepository.getLatestFor(ownerId, person, occasion)
  │                         │      ▼
  │  ◄──── MessageDraft ────┤  200 NextResponse.json(draft)
  │  ◄──── no body ─────────┤  204 when no latest draft exists
  │                         │
```

This is the Workspace restore path. In DB mode it validates the person and
occasion in the same owner-scoped transaction used by draft persistence, then
reads the newest `message_drafts` row for that person/occasion pair. If the
client passes an `occasionId`, it must belong to the person or the route
returns 404. If the client omits it, the service falls back to the person's
`nextOccasionId`; when there is no next occasion it reads the `NULL` occasion
bucket. Mock mode keeps a process-local in-memory store so any drafts
already POSTed (or PATCHed) within the current Node process round-trip
through this GET. A fresh process still returns a miss and Workspace falls
through to `POST /api/drafts`.

### `PATCH /api/drafts`

```
client                    server
  │                         │
  │  PATCH /api/drafts      │   { draftId, subject, paragraphs, attachedCard | null }
  ├────────────────────────►│
  │                         │  app/api/drafts/route.ts
  │                         │      │  parse JSON → 400 invalid_request on failure
  │                         │      ▼
  │                         │  lib/server/draft-service/index.server.ts
  │                         │      │  saveDraftEdit(input)
  │                         │      ├─ KEEPSAKE_DATA_SOURCE unset/mock
  │                         │      │    ▼
  │                         │      │  validate shape → 400 on miss
  │                         │      │  getMockDraftById(draftId)
  │                         │      │  no-op: same subject + body + card → return base
  │                         │      │  else: clone base, override subject + paragraphs + attachedCard,
  │                         │      │        recordMockDraft(new version) (newest-first)
  │                         │      │
  │                         │      └─ KEEPSAKE_DATA_SOURCE=db
  │                         │           ▼
  │                         │         validate shape → 400 on miss
  │                         │         non-UUID draftId → 404 (no SQL leak)
  │                         │         transaction(ownerId)
  │                         │           DraftRepository.getById(ownerId, draftId)
  │                         │             → 404 "Draft not found" (also covers cross-owner)
  │                         │           no-op: same subject + body + card → return base
  │                         │           DraftRepository.save with prompt_input_hash = NULL,
  │                         │             modelProvider/modelVersion unset
  │                         │           ▼
  │  ◄── 200 MessageDraft ──┤  NextResponse.json(updated draft)
  │                         │
```

The PATCH route exists so the user can persist Workspace compose edits —
`subject`, body `paragraphs`, and the optional card design — without expanding
the client's authorship over the rest of the `MessageDraft`. The route is
server-authoritative: `personId`, `occasionId`, `tone`, `quickActions`, and
`assistantNote` are inherited from the base draft and are not accepted from the
body. Every successful edit creates a new canonical
`message_drafts` row (or a new mock-store version); no in-place updates of
the base row. When the edit deep-equals the base, no row is inserted and the
base draft is returned as-is, so debounced autosaves do not inflate the
versions list. Edited rows persist with `prompt_input_hash = NULL` so
`findByPromptHash` (the generator's cache lookup) never returns
user-edited content as a cache hit.

Workspace consumes this surface: subject input is autosaved with a 700ms
debounce, card toggles save immediately, and `queueDelivery` awaits a
flush before POSTing to `/api/deliveries`. A failed save aborts the send
and surfaces an inline error toast instead of queuing a stale draft.

### `GET /api/drafts/versions`

```
client                    server
  │                         │
  │  GET /api/drafts/versions?personId=...&occasionId=...&limit=...
  ├────────────────────────►│
  │                         │  app/api/drafts/versions/route.ts
  │                         │      │   1. read query params
  │                         │      │
  │                         │      ▼
  │                         │  lib/server/draft-service/index.server.ts
  │                         │      ├─ KEEPSAKE_DATA_SOURCE unset/mock
  │                         │      │    ▼
  │                         │      │  return drafts:[]
  │                         │      │
  │                         │      └─ KEEPSAKE_DATA_SOURCE=db
  │                         │           ▼
  │                         │         auth/current-user.server.ts
  │                         │           ▼
  │                         │         db/transaction.server.ts
  │                         │           ▼
  │                         │         draft-context/db.server.ts
  │                         │           ▼
  │                         │         DraftRepository.listForPerson(ownerId, person, readLimit)
  │                         │      ▼
  │  ◄──── { drafts } ──────┤  200 NextResponse.json({ drafts })
  │                         │
```

This is the Workspace version-history read path. The route stays thin and
only parses query params before calling `listDraftVersions(input)`. In DB mode
the service validates person and occasion ownership in an owner-scoped
transaction, reads recent person drafts newest-first, filters to the resolved
occasion, and returns at most the safe limit (default 5, max 10). The
Workspace compose header renders a compact version strip when more than one
draft exists; selecting an older version only changes local compose display
state and appends a short AI note. It does not POST, save a new draft, send,
enqueue, or touch webhook/worker flows. In mock mode this endpoint returns
`{ drafts: [] }`, so the strip stays hidden.

### `GET /history`

```
browser                   server
  │                         │
  │  GET /history           │
  ├────────────────────────►│
  │                         │  app/history/page.tsx
  │                         │      │
  │                         │      ▼
  │                         │  lib/server/delivery-history/index.server.ts
  │                         │      │   getDeliveryHistory()
  │                         │      ├─ KEEPSAKE_DATA_SOURCE unset/mock
  │                         │      │    ▼
  │                         │      │  delivery-history/mock.server.ts → lib/mock.ts
  │                         │      │
  │                         │      └─ KEEPSAKE_DATA_SOURCE=db
  │                         │           ▼
  │                         │         auth/current-user.server.ts
  │                         │           ▼
  │                         │         db/transaction.server.ts
  │                         │           ▼
  │                         │         DeliveryRepository.listByMonth(ownerId, { limit: 50 })
  │                         │      ▼
  │  ◄──── History HTML ────┤  render month groups + rows
  │                         │
```

History is a server component page, not an API route. DB mode is read-only:
it reads sent delivery history under RLS. Enqueue, send workers, and webhook
status updates are still future work.

The page itself only calls the server helper `getDeliveryHistory()`; it does
not import `lib/mock.ts`, repositories, SQL helpers, or DB clients. The helper
lives behind `lib/server/delivery-history/index.server.ts`, which dispatches
to mock by default and to the DB implementation only when
`KEEPSAKE_DATA_SOURCE=db`.

### `POST /api/deliveries`

```
browser                   server
  │                         │
  │  POST /api/deliveries   │   body = { personId, occasionId | null, channel,
  │                         │            recipientEmail? }
  ├────────────────────────►│
  │                         │  app/api/deliveries/route.ts
  │                         │      │  parse JSON → 400 invalid_request on failure
  │                         │      │  currentUserIdOrThrow() → 401/500 on auth failure
  │                         │      ▼
  │                         │  lib/server/delivery-send/index.server.ts
  │                         │      │  enqueueDelivery(input)
  │                         │      ├─ KEEPSAKE_DATA_SOURCE unset/mock
  │                         │      │    ▼
  │                         │      │  delivery-send/mock.server.ts → validate + synthetic QueuedDelivery
  │                         │      │     (channel "email" requires a well-formed recipientEmail)
  │                         │      │
  │                         │      └─ KEEPSAKE_DATA_SOURCE=db
  │                         │           ▼
  │                         │         delivery-send/db.server.ts
  │                         │           │  validate UUIDs + channel + recipientEmail → 400
  │                         │           │  transaction(ownerId)
  │                         │           │     resolveDbDraftContextInTx
  │                         │           │       → 404 person_not_found / occasion_not_found
  │                         │           │     channel === "email":
  │                         │           │       GmailAccountRepository.getPrimary
  │                         │           │         → 409 sender_not_connected / sender_expired
  │                         │           │     DraftRepository.getLatestFor
  │                         │           │       → 409 no_draft
  │                         │           │     DeliveryRepository.enqueue
  │                         │           │       INSERT deliveries (status='queued',
  │                         │           │         sent_at=NULL, encrypted recipient_name +
  │                         │           │         recipient_email when email channel)
  │                         │           ▼
  │  ◄── 202 QueuedDelivery ┤  { id, personId, occasionId, draftId, channel,
  │                         │     status:"queued", scheduledForISO:null, createdAtISO }
  │                         │  (the response intentionally does NOT echo
  │                         │   recipientEmail — recipient identity stays on
  │                         │   the server-side queued row)
  │                         │
```

`recipientEmail` is the only piece of recipient identity the client supplies.
It is **required for the email channel** and must match a basic email-shape
check (`^[^\s@]+@[^\s@]+\.[^\s@]+$`, ≤254 chars); it is ignored for the post
channel. The value is encrypted into `deliveries.recipient_email_enc` at
enqueue and is the only column a future send worker can read to know which
address to deliver to. It is NOT written back to the `Person` row — Keepsake
deliberately does not yet have a `Person.email` (or `person_contacts`) model;
a future slice may add one and have `enqueue` prefer it over the request
body. The queued receipt that comes back to the client does NOT echo the
recipient email; the route only confirms "queued, with this draft id".

The route is the queue boundary: it accepts a request to send and persists a
`queued` row, but does not call Gmail itself. Email channel requires a
`connected` primary Gmail account; post channel skips the sender check
entirely. The thin route only does parse → auth → delegate → JSON; all
ownership, sender, and draft preconditions live behind the seam. The
`QueuedDelivery` shape is deliberately distinct from the sent-history
`Delivery` shape so we never force-fit a queued row (no `sent_at`) into a
history row. Draining the queue is the worker's job (see below).

### Delivery worker: queued → sent / failed

```
operator                  server
  │                         │
  │  pnpm worker:run        │   one-shot manual entry
  ├────────────────────────►│
  │                         │  scripts/run-delivery-worker.mjs
  │                         │      │
  │                         │      ▼
  │                         │  lib/server/delivery-worker/index.server.ts
  │                         │      │  processNextQueuedEmail()
  │                         │      ├─ KEEPSAKE_DATA_SOURCE unset/mock
  │                         │      │    ▼  → { status: "nothing_to_do" }
  │                         │      │
  │                         │      └─ KEEPSAKE_DATA_SOURCE=db
  │                         │           ▼
  │                         │         delivery-worker/db.server.ts
  │                         │           │
  │                         │           │  assertGmailTransportConfig()  ← pre-claim
  │                         │           │    missing GOOGLE_CLIENT_ID/_SECRET
  │                         │           │      → { status: "misconfigured", missing }
  │                         │           │        NO DB write, queue intact
  │                         │           │
  │                         │           │  Tx 1 (workerTransaction):
  │                         │           │   DeliveryRepository.nextQueued(1, tx)
  │                         │           │     SELECT FOR UPDATE SKIP LOCKED
  │                         │           │     WHERE status='queued' AND channel='email'
  │                         │           │     ORDER BY scheduled_for NULLS FIRST, created_at, id
  │                         │           │   markStatus(id, 'sending', tx)   ← claim
  │                         │           │   COMMIT
  │                         │           │
  │                         │           │  Tx 2 (workerTransaction, read-only):
  │                         │           │   DraftRepository.getEditBaseById  (draft.subject + paragraphs)
  │                         │           │   GmailAccountRepository.getSendingCredentials
  │                         │           │     → null / status != connected → mark failed
  │                         │           │
  │                         │           │  Gmail HTTP (no DB lock held):
  │                         │           │   delivery-worker/gmail-transport.server.ts
  │                         │           │     POST GOOGLE_TOKEN_ENDPOINT (refresh → access)
  │                         │           │     POST KEEPSAKE_GMAIL_API_BASE /gmail/v1/.../messages/send
  │                         │           │       raw = base64url(plain-text MIME)
  │                         │           │
  │                         │           │  Tx 3 (workerTransaction):
  │                         │           │   markStatus(id, 'sent', providerMessageId, tx)
  │                         │           │       OR markStatus(id, 'failed', null, tx)
  │                         │           │   on token_invalid: also markExpired(gmail_account)
  │                         │           ▼
  │  ◄── JSON result ───────┤    WorkerResult:
  │                         │      { status: "nothing_to_do" }
  │                         │      | { status: "sent",   deliveryId, providerMessageId: string }
  │                         │      | { status: "failed", deliveryId, reason, detail? }
  │                         │      | { status: "misconfigured", missing: string[] }
```

Concurrent workers can't double-send the same row: `nextQueued` uses
`SELECT FOR UPDATE SKIP LOCKED`, and the claim transaction flips the row
to `status='sending'` before committing — subsequent `nextQueued` calls
filter to `status='queued'` and never see it again. Crash between Tx 2
and Tx 3 leaves the row stuck in `sending`; there is no reaper or retry
queue today, so operators handle that manually. `markStatus` is
idempotent (no-op on re-call with the same status; `sent_at` and
`provider_message_id` are monotonic). The Gmail send path is strict
about the canonical message id: a 2xx response without an `id` field is
normalised to `transport_error` and the delivery is marked `failed` —
we refuse to mark a delivery `sent` without an id we can later reconcile
against webhooks. `WorkerResult.sent.providerMessageId` is therefore
always a non-empty string. This slice only supports the `email` channel;
post-channel rows stay queued indefinitely.

**Worker-level misconfiguration never burns the queue.**
`assertGmailTransportConfig()` runs BEFORE the claim transaction; if
`GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` is missing, the worker
returns `{ status: "misconfigured", missing }` without claiming or
mutating any row. This separates deployment problems (the operator
fixes env) from per-delivery failures (the operator investigates that
one row).

Status lifecycle (post P5-B):

```
queued ──claim──► sending ──Gmail OK──► sent ──webhook──► delivered ──open──► opened
   ▲                 │
   │                 └─Gmail / token error──► failed
   │
   └───stale recovery───── (only when `updated_at < now() - staleAfterSeconds`)
       see runtime.server.ts: requeueing a stuck `sending` row CAN
       cause a duplicate send when Gmail accepted the original send
       but the worker died before the finalise tx committed.
```

### Delivery-worker runtime: `runWorkerLoop`

```
operator                  server
  │                         │
  │  pnpm worker:run        │   one call → many ticks + optional recovery
  ├────────────────────────►│
  │                         │  scripts/run-delivery-worker.mjs
  │                         │      │
  │                         │      ▼
  │                         │  lib/server/delivery-worker/index.server.ts
  │                         │      │  runWorkerLoop(options)
  │                         │      ▼
  │                         │  lib/server/delivery-worker/runtime.server.ts
  │                         │      │
  │                         │      │  preflight()                         ← side-effect free
  │                         │      │    DB mode: assertGmailTransportConfig()
  │                         │      │    mock mode: always []
  │                         │      │  if (missing.length > 0)
  │                         │      │    return { stopReason: "misconfigured", missing }
  │                         │      │    ↑ NO recovery, NO tick, NO DB writes
  │                         │      │
  │                         │      │  if (options.recovery)
  │                         │      │    recover(staleAfterSeconds)        ← once
  │                         │      │       requeueStaleSending(seconds)
  │                         │      │
  │                         │      │  loop:
  │                         │      │    result = await tick()             ← processNextQueuedEmail
  │                         │      │    if nothing_to_do  → stop "empty"
  │                         │      │    if misconfigured  → stop "misconfigured"
  │                         │      │    if failed & stopOnFailure → stop "stopped_on_failure"
  │                         │      │    if ticks ≥ maxTicks → stop "max_ticks"
  │                         │      │    on tick exception  → stop "fatal_error"
  │                         │      ▼
  │  ◄── JSON summary ──────┤   DeliveryWorkerLoopSummary:
  │                         │     { ticks, sent, failed, recovered,
  │                         │       stopReason, missing?, fatalError? }
```

Defaults in `pnpm worker:run` (overridable via env):
- `KEEPSAKE_WORKER_MAX_TICKS=50`
- `KEEPSAKE_WORKER_RECOVERY_AFTER=600` (10 minutes; `0` disables recovery)
- `KEEPSAKE_WORKER_STOP_ON_FAILURE` unset

Manual-run exit codes (the script never daemonises):
- **0** clean run, no per-delivery failures
- **2** the loop recorded at least one per-delivery `failed`
- **3** deployment-level misconfiguration (queue untouched)
- **4** unexpected runtime crash inside the loop

### Stuck-`sending` recovery — explicit duplicate-send risk

The worker uses three transactions on purpose (claim, hydrate, finalise)
so we never hold a row lock across the Gmail HTTP call. If the process
dies between Gmail's 2xx and the finalise tx commit, the row stays
`sending` forever; there is no Gmail-side idempotency we can rely on.

`runWorkerLoop({ recovery: { staleAfterSeconds } })` adds a one-shot
recovery pass:
`DeliveryRepository.requeueStaleSending(seconds)` runs
`UPDATE deliveries SET status='queued', provider_message_id=NULL,
updated_at=now() WHERE status='sending' AND updated_at < now() -
make_interval(secs => $1)` and returns the recovered ids. The loop's
`recovered` count surfaces straight to the operator so a non-zero
value is auditable.

**This can cause a duplicate send.** A row stuck in `sending` MAY have
been delivered to Gmail before the worker crashed. Requeueing it means
the recipient gets a second copy. We chose requeue over "mark failed"
because:
- A duplicate is recoverable (the recipient sees two warm messages);
  a silent drop is not (the user thinks Keepsake delivered it).
- The threshold is operator-controlled, so a careful operator can
  inspect the row before relaxing the window.

This is NOT a retry queue. There is no backoff, no max-attempts, no
dead-letter. Operators decide what to do with `failed` rows; they're
not auto-retried.

Out of scope this slice (deferred to later P-checkpoints): webhook
ingest (`provider_message_id` is captured but `findByProviderMessageId`
is implemented for future use), retry / backoff queue, cron / daemon,
batch / concurrent draining, post-channel worker, HTML email,
attachments, threaded replies.

Workspace consumes this boundary: `app/workspace/WorkspaceClient.tsx` POSTs
to `/api/deliveries` when the user clicks `Send email` / `Mail as card`,
disables both buttons during the request, and surfaces queue-honest copy
("Queued email for Lin." — never "sent"/"delivered"). 401 / 404
`person_not_found` / 404 `occasion_not_found` / 409 `sender_not_connected` /
409 `sender_expired` / 409 `no_draft` each map to user-facing prompts without
inventing new server fields. There is still no send worker, so the queued
row sits in `deliveries` with `sent_at IS NULL` until a future slice drains
it. Before POSTing, `queueDelivery` awaits `flushDraftEdits()` so any
debounced `PATCH /api/drafts` autosave (subject / card toggle) lands as a
new canonical `message_drafts` version first; if the save fails the send
is aborted and an error toast is surfaced. The queued row therefore
references whatever the user just saw, not a stale generator output.

---

### `POST /api/webhooks/deliveries` — provider status callback

```
provider                  server
  │                         │
  │  POST /api/webhooks/    │   header  x-keepsake-webhook-secret: <env-shared>
  │       deliveries        │   body    { provider: "gmail"|"mock",
  ├────────────────────────►│             providerMessageId, event,
  │                         │             occurredAtISO?, failureReason?,
  │                         │             providerStatus? }
  │                         │  app/api/webhooks/deliveries/route.ts
  │                         │      │  env DELIVERY_WEBHOOK_SECRET unset → 501 not_configured
  │                         │      │  header mismatch                  → 401 unauthorized
  │                         │      │  json parse failure               → 400 invalid_json
  │                         │      ▼
  │                         │  lib/server/delivery-webhook/ingest.server.ts
  │                         │      │  validate event shape             → 400 invalid_event (+ detail)
  │                         │      ├─ KEEPSAKE_DATA_SOURCE unset/mock
  │                         │      │    ▼
  │                         │      │  mock.server.ts → 404 delivery_not_found
  │                         │      │
  │                         │      └─ KEEPSAKE_DATA_SOURCE=db
  │                         │           ▼
  │                         │         db.server.ts (workerTransaction — BYPASSRLS)
  │                         │           │  DeliveryRepository.findByProviderMessageId
  │                         │           │       no row → 404 delivery_not_found
  │                         │           │  DeliveryRepository.markStatus({ deliveryId,
  │                         │           │       status, providerStatus?, deliveredAtISO?,
  │                         │           │       openedAtISO?, failureReason? })
  │                         │           │       monotonic: queued < sending < sent <
  │                         │           │       delivered < opened; 'failed' writable
  │                         │           │       only from {queued, sending, sent}.
  │                         │           │       Regression requests freeze ALL fields.
  │                         │           ▼
  │  ◄── 200 { ok, status,  ┤  status = row's final status (idempotent)
  │           deliveryId,   │  updated = true iff this call changed status
  │           updated }     │
  │                         │
```

The webhook is identity-by-`providerMessageId`: it does NOT call
`currentUserOrThrow()` and is NOT a Keepsake user-session route. The
provider is whoever holds the shared `DELIVERY_WEBHOOK_SECRET`. The
worker stamped `provider_message_id` on the row when it sent the
message; the webhook closes the loop by reading status callbacks back
into the same row. `provider_message_id` is DB-unique when non-null
(`deliveries_provider_msg_idx`, partial UNIQUE), so the webhook
lookup is unambiguous — duplicate worker writes would fail at insert
time rather than fork the status timeline.

Event → status mapping:

- `delivered` → status `delivered`; stamps `delivered_at`
- `opened`    → status `opened`; stamps `opened_at` (AND `delivered_at`
  if null, since opened implies delivered)
- `failed`    → status `failed`; stamps `failure_reason`

`occurredAtISO` is the provider-reported event time; when omitted, the
repo stamps `now()` instead. Late-arriving callbacks that would
*regress* status (e.g. `delivered` after `opened`, or `failed` after
`opened`) return `200 { updated: false, status: <unchanged> }` and the
DB row's timestamps / diagnostic fields stay frozen — providers can
retry safely.

The webhook deliberately does NOT send any email, run the worker, or
revoke OAuth grants. The route is the contract; a future Gmail push
subscription is its own slice and will land as a new
`provider: "gmail"` adapter on top of the same ingest.

To exercise the full Workspace → worker → webhook → History loop by
hand (env groups, curl payloads, and per-step troubleshooting), see
[docs/DELIVERY_RUNBOOK.md](./DELIVERY_RUNBOOK.md).

P7-A writes the row's terminal status; P7-B (`app/history/page.tsx`)
reads it back. The History page maps `deliveries.status` to a tone
trio via `deliveryStatusBadge` in `lib/presentation.ts`:

- `queued` / `sending` / `sent` → neutral (gray / blue clock + send icons)
- `delivered` / `opened` → success (`#3F9E78` green check)
- `failed` → warn (`#C2381C` red `i-alert` — visually distinct from
  the success green, so a bounced row is never read as "ok")

Each row also tags itself with a `data-delivery-status="<value>"`
attribute so smoke tests can assert the tone families don't blur.
The History page does NOT poll for updates — a fresh page navigation
re-reads the row's current status. Live updates / SSE / polling are
explicit non-goals for this slice.

---

### Command channel platform (P8-A foundation)

WhatsApp, Telegram, Slack, and similar tools are treated as command
channels rather than mobile clients. They let users ask for relationship
follow-ups, request drafts, revise tone, and receive reminders from the phone,
while the web app remains the **execution + review** surface for editing,
account setup, and final send confirmation.

P8-A ships the provider-agnostic contract: a normalised `CommandEvent`, a
pure-logic router, a `CommandResponse` discriminated by status, and one
mock route so the contract is testable without WhatsApp / Telegram / Slack.
P8-B adds the identity-link schema (`channel_accounts`) and the repository
interface (`ChannelAccountRepository`). P8-C adds the Postgres runtime.
P8-D adds a DB-backed **mock inbound** route that proves provider
identity resolution end-to-end: `(provider, externalUserId) → owner_id`
through `channel_accounts`, then the same router. P8-E adds an
**owner-scoped read path**: once identity is resolved, a
`relationship_followup_query` is answered with that owner's actual
people + upcoming occasions (read-only, top 3 within 30 days), so
the channel reply names real names instead of returning a generic
acknowledgment. The web app stays the place where the user actually
drafts and sends — the channel only points back. Real provider
webhooks land in later slices; each will verify its provider
signature, normalise its payload into the same `CommandEvent`, and
delegate to the same router / owner-command path.
P8-G adds a concrete `reviewUrl` to channel responses: follow-up
queries point to `/people`, compose requests point to `/workspace`
with encoded recipient/context hints, and link-needed responses point
to `/profile#command-channels`. The URL is still a review pointer, not
an execution claim.
P8-H lands the first real provider adapter: `POST /api/channels/telegram`
verifies Telegram's `X-Telegram-Bot-Api-Secret-Token`, normalises private
text updates into `CommandEvent`, resolves `(provider="telegram",
externalUserId)` through `channel_accounts`, and replies through Telegram
Bot API `sendMessage` with the same review URL. It does not create drafts,
enqueue deliveries, or call Gmail.

P8-I adds the first Profile-side Telegram linking UX. In DB mode,
`app/profile/page.tsx` renders a manual "Link Telegram user" form that POSTs
to `/api/channels/telegram/link`; users/operators paste the numeric Telegram
user id, which creates the same `channel_accounts(provider="telegram")` row the
adapter resolves. `/api/channels/telegram/revoke` revokes those rows. This is
still manual provisioning, not a Telegram `/start <token>` handshake.

P8-J adds that `/start <token>` handshake without a new table. In DB mode,
Profile renders `https://t.me/<TELEGRAM_BOT_USERNAME>?start=<token>` when
`TELEGRAM_BOT_USERNAME` and `APP_SESSION_SIGNING_SECRET` are configured. The
token is stateless, expires after 15 minutes, fits Telegram's 64-character
deep-link limit, and is HMAC-signed with a Telegram-specific context string.
When `POST /api/channels/telegram` receives `/start <token>`, it verifies the
token, links `message.from.id` to the token owner in `channel_accounts`, and
then future messages from that Telegram user resolve through the normal
provider identity path.

```text
WhatsApp webhook ┐                                    ┌─ ChannelAccountRepository
Telegram webhook ├─ provider adapter ──> CommandEvent ┤  .findByProviderUser(provider,
Slack events     ┘   (sig verify,                     │   externalUserId)            ──> owner_id
mock inbound      ┘    normalise)                     │                              ──> null (link-needed)
                                                      │
                                                      └─ routeCommandEvent ──> CommandResponse
                                                         (deterministic,         (status, intent,
                                                          keyword-based today)    suggestedAction)
```

The boundary types live in `lib/server/channels/types.ts`:

```ts
type ChannelProvider = "whatsapp" | "telegram" | "slack" | "mock";

interface CommandEvent {
  provider:          ChannelProvider;
  externalUserId:    string | null;   // provider-side user id
  externalThreadId:  string | null;   // provider-side conversation id
  text:              string;          // user message body (trimmed)
  receivedAtISO:     string;          // provider event timestamp
  raw?:              unknown;         // opaque original payload
}

type CommandIntent =
  | "relationship_followup_query"     // "who should I follow up with?"
  | "compose_request"                 // "send Helen an email — she got promoted"
  | "unknown";

interface CommandResponse {
  status:           "ok" | "needs_review" | "unsupported";
  text:             string;           // reply body the adapter renders back to chat
  intent:           CommandIntent;
  suggestedAction?: SuggestedAction;  // open_relationship_followups | open_compose_workspace
  reviewUrl?:       string;           // relative Keepsake URL for review/action
}
```

The status field is load-bearing: even a successful `compose_request`
returns `needs_review`, never `ok`. The channel layer **never sends mail,
never enqueues a delivery, never creates a draft**. Adapters render
`response.text` back into the chat; the user finishes the action in
Keepsake. The `reviewUrl` is a relative URL that adapters may render
as a button or prepend with the deployment origin. It never means the
channel executed the command. The smoke `pnpm test:channels` pins this
by asserting that replies never contain "sent", "delivered", or
"queued".

`lib/server/channels/router.server.ts` exports
`routeCommandEvent(event)` — pure logic, no DB, no LLM, no provider
API. P8-A uses keyword classification (中文 "发邮件" / "跟进", English
"follow up" / "email Helen"); a later slice may add an LLM
classifier behind the same seam.

`POST /api/channels/mock` is the local test endpoint:

```bash
curl -sS -X POST http://localhost:3000/api/channels/mock \
  -H 'content-type: application/json' \
  -d '{"text":"帮我给 Helen 发一个邮件，她今天升职了"}'
# → 200 { status: "needs_review", intent: "compose_request",
#         text: "I drafted the request, but you'll review and send it in Keepsake.",
#         suggestedAction: { kind: "open_compose_workspace", recipientHint: "Helen", … },
#         reviewUrl: "/workspace?source=channel&recipientHint=Helen&contextHint=..." }
```

The route is local-only; it accepts `provider: "mock"` (or omitted),
does NOT authenticate the caller, does NOT verify signatures. Real
provider webhooks will arrive at their own routes (`/api/channels/whatsapp`,
etc.) once those adapters land — each will verify provider signatures,
dedupe by provider message id, and call the same `routeCommandEvent`
seam.

`POST /api/channels/mock/inbound` is the DB-backed mock provider-adapter
shape. It exists only for local/dev proof of the provider identity chain:
malformed body → 400, non-DB data source → 501 `not_configured`,
unlinked or revoked `(provider="mock", externalUserId)` → 200
`needs_link`, and active links → `routeCommandEvent()` response plus a
dev-only `ownerId` echo so the DB smoke can prove which owner was
resolved. It never reads `currentUser*`, `keepsake_session`, or
`DEV_OWNER_*`; the smoke sets `DEV_OWNER_ID` to a different user and
asserts an unlinked external id still gets `needs_link`.
Missing or revoked links include `reviewUrl: "/profile#command-channels"`;
real provider adapters should render that as the account-link CTA.

`POST /api/channels/telegram` is the first real provider adapter:

- Gate: requires `TELEGRAM_WEBHOOK_SECRET` and validates Telegram's
  `X-Telegram-Bot-Api-Secret-Token` header before any identity lookup.
- Runtime config: requires `KEEPSAKE_DATA_SOURCE=db`,
  `TELEGRAM_BOT_TOKEN`, and `KEEPSAKE_APP_ORIGIN`; optional
  `TELEGRAM_API_BASE` exists only for local/stub testing.
- Normalisation: text messages become `CommandEvent` with
  `provider: "telegram"`, `externalUserId = message.from.id`, and
  `externalThreadId = message.chat.id`.
- Identity: active `channel_accounts` rows delegate to
  `handleOwnerCommand(ownerId, event)`; missing or revoked rows get a
  link-needed reply to `/profile#command-channels`.
- Reply: the adapter calls Telegram Bot API `sendMessage` with the
  response text plus an absolute Keepsake review URL. The JSON response
  does **not** echo internal `ownerId`.
- Non-goals: no draft creation, no queue/send, no Gmail, no update-id
  dedupe persistence, no one-time nonce table for start tokens yet.

Provider adapters MUST:

- Verify webhook signatures / shared secrets before calling the router.
- Dedupe provider message ids.
- Normalise into `CommandEvent` — the router shouldn't see provider
  payloads.
- Delegate intent execution to owner-explicit server seams (future
  `getPeoplePayloadForOwner(ownerId)`, `generateDraftForOwner(ownerId, …)`,
  etc.) — NOT to `app/api/*` over HTTP, NOT to `lib/mock.ts`, NOT to
  `draft-generator` directly, NOT to Gmail OAuth/account repositories,
  NOT to crypto helpers, NOT to worker-only delivery methods.

Channel identity is **not auth**. A Telegram chat/user id, WhatsApp
`wa_id`/phone, or Slack user/team/channel id links to a Keepsake
`owner_id` through the `channel_accounts` table (P8-B) — never through
columns on `users`. Webhook routes do not have web sessions and must
not call `currentUserIdOrThrow()`. A webhook with no matching row
MUST respond with a link-needed acknowledgment; it MUST NOT fall back
on a `keepsake_session` cookie, a `DEV_OWNER_*` env value, or the
request-path user. The `ChannelAccountRepository.findByProviderUser`
contract pins this — see `lib/repositories/channel-accounts.ts`.

Provider notes (still future):

- **WhatsApp** — the important long-term command inbox for user tasks
  and notifications, but it has provider policy constraints: inbound
  user messages can be answered as service messages during the
  customer-service window, while proactive reminders outside that
  window require template-aware notification logic.
- **Telegram** — first real adapter (P8-H): private text webhook
  handling is wired through the shared command path and replies via
  Bot API `sendMessage`. P8-I adds a manual Profile link/revoke form
  for Telegram user ids. P8-J adds signed `/start <token>` linking.
  Dedupe, inline keyboards, callback queries, and reminders are still future slices.
- **Slack** — slash commands, app mentions, and interactive buttons
  all delegate to the same router via the same `CommandEvent` shape.

---

## 2. Layer responsibilities

| Layer | Path | Job today | Touches HTTP? | Touches DB? | Touches LLM? |
|---|---|---|---|---|---|
| Pages | `app/page.tsx`, `app/people/`, `app/workspace/`, `app/history/`, `app/profile/` | Render. Home and People now call the ReMaster compatibility overview seam, which derives account/contact/activity cards from people payload + delivery history while the underlying schema remains person-centered; People receives the same seam's legacy payload only for drawer details, Add contact options, and mock-mode `local-*` browser continuity, posts "Add contact" to `/api/people`, and keeps Workspace links on `/workspace?person=<primaryContactId>`; Home, Workspace, and Profile read current user identity from the auth seam; Workspace has not migrated yet and still receives an initial people payload from its server wrapper, then keeps draft restore/generate/version interactions behind `/api/drafts`, autosaves subject + body + card toggle through `PATCH /api/drafts`, and POSTs the send buttons to `/api/deliveries` for queue-boundary enqueue (after first flushing any pending edits); History has not migrated yet and still calls the delivery-history dispatcher. | yes (People create, Workspace draft fetches + autosave PATCH + delivery enqueue) | via server helper when DB mode is enabled | no |
| API routes | `app/api/session/route.ts`, `app/api/auth/signout/route.ts`, `app/api/oauth/gmail/*/route.ts`, `app/api/people/route.ts`, `app/api/drafts/route.ts`, `app/api/drafts/versions/route.ts`, `app/api/deliveries/route.ts`, `app/api/gmail/disconnect/route.ts`, `app/api/webhooks/deliveries/route.ts`, `app/api/channels/mock/route.ts`, `app/api/channels/mock/inbound/route.ts`, `app/api/channels/mock/link/route.ts`, `app/api/channels/mock/revoke/route.ts`, `app/api/channels/telegram/route.ts`, `app/api/channels/telegram/link/route.ts`, `app/api/channels/telegram/revoke/route.ts` | Parse/return JSON and delegate. `/api/session` exposes the stable `{ user }` contract and maps auth errors; `/api/auth/signout` clears `keepsake_session` and 303s to `/signin` (no DB, no Google revoke, no Gmail disconnect); Gmail OAuth routes own the connect flow; `/api/people` GET returns `PeoplePayload` and POST creates a `Person` through the people-create seam; draft routes can be mock- or DB-backed behind `KEEPSAKE_DATA_SOURCE`; `/api/drafts` POST swaps between mock and LLM behind `KEEPSAKE_DRAFT_SOURCE` (default mock) and PATCH persists Workspace subject + body + card edits as new canonical draft versions; `/api/deliveries` is the send-boundary contract that returns 202 `QueuedDelivery` without calling Gmail; `/api/webhooks/deliveries` is the provider-agnostic delivery-status callback (shared-secret gate, never reads current user); `/api/channels/mock` exercises the pure router; `/api/channels/mock/inbound` exercises DB-backed provider identity resolution and returns a review pointer only; `/api/channels/mock/{link,revoke}` and `/api/channels/telegram/{link,revoke}` are owner-scoped Profile mutations that manage `channel_accounts` rows inbound routes then resolve against; `/api/channels/telegram` is the first real provider adapter and now also consumes `/start <token>` link commands: Telegram secret header → optional start-token link → DB identity lookup → owner-scoped command reply → Telegram `sendMessage` with review URL. The ReMaster compatibility overview is still page-only for Home + People and does not add a new API route or change `/api/people`. | yes | people create/read + draft persistence/cache/latest/version reads + edited-version inserts, gmail-account read for sender precondition, delivery enqueue in DB mode only, delivery status updates from webhook in DB mode only, channel-account lookup for mock/Telegram inbound in DB mode only | optional via `KEEPSAKE_DRAFT_SOURCE=openai` |
| Server services | `lib/server/remaster-overview/index.server.ts`, `lib/server/people-payload/{index,db,mock}.server.ts`, `lib/server/people-create/{index,db,mock}.server.ts`, `lib/server/draft-service/{index,db,mock,generator-errors}.server.ts`, `lib/server/draft-context/{index,db,mock}.server.ts`, `lib/server/draft-generator/{index,mock,openai}.server.ts`, `lib/server/delivery-history/{index,db,mock}.server.ts`, `lib/server/delivery-send/{index,db,mock,types}.server.ts`, `lib/server/auth/current-user.server.ts`, `lib/server/oauth/gmail.server.ts`, `lib/server/db/transaction.server.ts`, `lib/server/crypto/envelope.server.ts` | Server-only orchestration. `auth/current-user` is the only current-user / owner resolver; `oauth/gmail` owns the Gmail provider boundary; people payload/create, drafts, draft context, delivery history, and delivery send are DB-capable runtime verticals; `remaster-overview/index.server.ts` is the compatibility migration seam for Home + People, composing people payload + delivery history into derived account/contact/activity read models and returning the legacy payload only where People still needs drawer/add compatibility; `draft-generator/index.server.ts` dispatches `mock` vs `openai` behind `KEEPSAKE_DRAFT_SOURCE` so the route contract stays unchanged; `delivery-send` is the queue boundary (validate → ownership → sender precondition → latest draft → enqueue, no Gmail call). | no | yes in DB mode | optional via `KEEPSAKE_DRAFT_SOURCE=openai` |
| Mock store | `lib/mock.ts` | In-memory data: 5 people, 7 occasions, 4 cultures, 5 relationships, 4 deliveries + finder helpers. | no | no | no |
| Domain | `lib/domain.ts` | Canonical TypeScript types — the contract between layers and over the wire. No HTML in message content. Card/icon hints are explicit structured fields, not rendered markup. | no | no | no |
| Presentation | `lib/presentation.ts` | Maps `OccasionKind`/`Tone`/`Channel` → icon names, gradients, chip text. UI only. | no | no | no |
| Repository implementations | `lib/repositories/catalog.server.ts`, `lib/repositories/people.server.ts`, `lib/repositories/drafts.server.ts`, `lib/repositories/deliveries.server.ts`, `lib/repositories/gmail-accounts.server.ts`, `lib/repositories/channel-accounts.server.ts` | Postgres implementations for catalog, people/occasion reads, person create, message draft persistence/cache, delivery history reads, delivery enqueue/worker/webhook status updates, Gmail account metadata/token storage, and command-channel account identity. People update/delete and occasion writes remain future work. | no | yes | no |
| DB scripts | `db/schema.sql`, `db/seed_catalog.sql`, `scripts/seed-dev-fixtures.mjs` | Postgres 17 schema + catalog seed + encrypted local-dev fixture seed. | no | yes (manual/dev) | no |
| Dev env helpers + smoke tests | `scripts/init-dev-env.mjs`, `scripts/check-dev-env.mjs`, `scripts/test-env-init.mjs`, `scripts/test-dev-env.mjs`, `scripts/test-auth-current-user.mjs`, `scripts/test-session-route.mjs`, `scripts/test-gmail-oauth-routes.mjs`, `scripts/test-home.mjs`, `scripts/test-people.mjs`, `scripts/test-drafts.mjs`, `scripts/test-history.mjs`, `scripts/test-profile.mjs`, `scripts/test-workspace.mjs`, DB Docker tests | `pnpm env:init` creates `.env.local` from `.env.example` without overwriting. `pnpm dev` first checks the local env needed by Home/Profile/session and, in DB mode, the DB/encryption vars. Default `pnpm test` covers both env helpers plus auth/session, OAuth stubs, mock HTTP/page contracts, command-channel contracts, and the full MVP demo smoke. `pnpm test:db` boots Docker Postgres and covers transaction/repository/fixture/DB-route paths, including DB-backed people, drafts, deliveries, Gmail accounts, auth, history, webhook, worker, and channel identity paths. | yes (HTTP/page smoke) | DB suite only | no |
| MVP demo close-out | `scripts/test-mvp-demo-flow.mjs`, `docs/MVP_DEMO_RUNBOOK.md` | `pnpm test:mvp-demo` boots the mock-mode app, signs in via the dev-session route, visits every product page, checks the Workspace icon fallback, drafts, queues a delivery, exercises command-channel review URLs, signs out, and verifies guarded-page redirects. The runbook freezes the desktop MVP demo and lists deferred work. | yes | no | no |

---

## 3. Stable contracts (don't break without a heads-up)

These are the load-bearing pieces. Changing them ripples; flag them in the
PR/agent prompt before touching.

1. **`lib/domain.ts` shapes** — `Person`, `OccasionNode`, `MessageDraft`,
   `Delivery`, `Relationship`, `CultureRule`, `PeoplePayload`,
   `DraftRequest`. Every layer round-trips these. The DB schema in
   [`db/schema.sql`](../db/schema.sql) is built around them.
2. **`GET /api/people` response shape** = `PeoplePayload`. Covered by
   `pnpm test:people`, which also smokes the People account/contact
   compatibility page without changing the API contract.
3. **Current-user shape** =
   `{ id, email, name, initials, sendingAccount }`. Mock mode returns
   `sendingAccount: null`; DB mode fills it from the owner's primary
   `gmail_accounts` row as `{ provider: "gmail", email, status }`.
   `GET /api/session` returns the shape
   as `{ user }`; `app/page.tsx` renders `name` in the greeting,
   `app/workspace/page.tsx` passes it to the client composer as read-only sender
   identity, and `app/profile/page.tsx` renders the same shape through the
   server auth helper. Covered by `pnpm test:auth`, `pnpm test:home`,
   `pnpm test:workspace`, `pnpm test:profile`, and
   `pnpm test:db:current-user`.
   The route calls only `auth/current-user`, maps missing auth to 401, and
   maps invalid dev env to 500. It is the public contract that real auth will
   preserve.
4. **Local env helpers** = `scripts/init-dev-env.mjs` and
   `scripts/check-dev-env.mjs`. `pnpm env:init` creates `.env.local` from
   `.env.example` and refuses to overwrite unless `--force` is passed.
   `pnpm dev` then preflights the resulting env: mock mode requires
   `DEV_OWNER_ID`, `DEV_OWNER_EMAIL`, and `DEV_OWNER_NAME`; DB mode additionally
   requires `DATABASE_URL` and a 32-byte `DEV_ENCRYPTION_KEY_BASE64`.
   `.env.example` is documentation only for the preflight. Covered by
   `pnpm test:env-init` and `pnpm test:dev-env`.
5. **Gmail OAuth routes** =
   `GET /api/oauth/gmail/start` and `GET /api/oauth/gmail/callback`. They
   require current-user auth, then delegate to
   `lib/server/oauth/gmail.server.ts`. Returns 401 missing auth, 500 invalid
   dev auth, 400 invalid/provider-denied callback or any state/exchange
   failure, and 501 `not_configured` when any of `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, or
   `OAUTH_STATE_SIGNING_SECRET` (>=32 chars) is missing. Fully configured:
   start returns 307 to Google + HMAC-signed state cookie; callback verifies
   the cookie, exchanges the code via native `fetch` to `GOOGLE_TOKEN_ENDPOINT`,
   extracts the account email from the `id_token`, opens a short
   `transaction(ownerId, ...)` and calls
   `GmailAccountRepository.upsertPrimary` with the plaintext refresh token
   (encrypted at the repository boundary), then 307s to the cookie's safe
   `returnTo` and clears the cookie. The routes never write Gmail accounts
   directly, never see plaintext tokens after the seam returns, and never
   send or enqueue. Covered by `pnpm test:oauth` (validation paths) and
   `pnpm test:db:gmail-callback` (full DB write path + replay).
6. **`POST /api/drafts` request shape** = `{ personId, occasionId, userInstruction }`,
   nothing else. Anything that smells like "let the client name a
   relationship / culture / tone override" violates the server-authoritative
   contract. Extra body fields are ignored by the service and never included
   in DB prompt hashing. Covered by `pnpm test:drafts`.
7. **`POST /api/drafts` response shape** = `MessageDraft`. Same coverage.
   The route shape does not move when `KEEPSAKE_DRAFT_SOURCE=openai`: the
   LLM seam still returns a `MessageDraft`, and any provider failure (missing
   API key, network error, malformed JSON, unsupported tone) maps to a 500
   with `{ error: "Draft generator is misconfigured" | "… unavailable" | "… returned an unusable response" }`.
   Provider URLs, status codes, and stack traces never leave the server.
   Covered by `pnpm test:draft-generator` (mock default + missing key +
   stubbed-OK + malformed response).
8. **`GET /api/drafts` request shape** = query params `{ personId, occasionId? }`.
   It never accepts relationship, culture, tone, or instruction overrides.
   It returns `MessageDraft` on 200 and no body on 204 miss.
9. **`GET /api/drafts/versions` request shape** = query params
   `{ personId, occasionId?, limit? }`. It returns `{ drafts: MessageDraft[] }`
   newest-first. Mock mode returns versions from a process-local store
   (anything POSTed or PATCHed in the current process); DB mode is read-only
   and validates person/occasion ownership before calling
   `DraftRepository.listForPerson`.
9.5. **`PATCH /api/drafts` request shape** =
   `{ draftId, subject, paragraphs, attachedCard }`, where `paragraphs` is
   a `DraftParagraph[]` and `attachedCard` is either `null` or a full
   `AttachedCard` object (no partials). Nothing else is accepted —
   `personId`, `occasionId`, `tone`, `quickActions`, and `assistantNote`
   are inherited from the base draft and cannot be overridden from the client. Response
   is `MessageDraft` on 200 (a new canonical version, or the unchanged
   base when the edit is a no-op). Errors: 400 invalid JSON or missing /
   malformed fields; 404 `Draft not found` for unknown ids, non-UUID
   draftIds in DB mode, and cross-owner draftIds (the 404 is identical to
   "doesn't exist" so the route never leaks who owns what). Covered by
   `pnpm test:drafts` (mock) and `pnpm test:db:drafts-route` (DB under
   RLS).
10. **Culture rules resolve server-side only.** The client never sends a
   `CultureRule`; the server reads it from the person's `culture_id`.
   Implementation in `lib/server/draft-service/` plus
   `lib/server/draft-context/`, backed by mock by default or DB context when
   `KEEPSAKE_DATA_SOURCE=db`.
11. **`MessageDraft.paragraphs[].text` is plain text.** Highlights live in
   `paragraphs[].highlights: string[]`, applied by the client renderer
   (see [`app/workspace/page.tsx`](../app/workspace/page.tsx) — the
   `renderParagraph` helper). No `<span>`, no HTML strings, ever.
12. **`POST /api/deliveries` request shape** = `{ personId, occasionId | null, channel: "email" | "post", recipientEmail? }`.
    `recipientEmail` is required and basic-email-validated when
    `channel === "email"`; ignored otherwise. Returns 202 `QueuedDelivery`
    on success (`{ id, personId, occasionId, draftId, channel,
    status: "queued", scheduledForISO: null, createdAtISO }`) — the response
    deliberately does NOT echo `recipientEmail`. 400 `invalid_request` for
    parse, UUID, channel, or recipient-email shape failures; 401 missing
    auth / 500 misconfigured auth; 404 `person_not_found` /
    `occasion_not_found`; 409 `sender_not_connected` / `sender_expired`
    (email channel only) / `no_draft`. The route is a queue boundary: it
    never calls Gmail and never mutates delivery status. Covered by
    `pnpm test:deliveries` (mock + validation, incl. recipient-email shape
    cases) and `pnpm test:db:deliveries-route` (full DB happy path +
    sender precondition + ownership + encrypted row inspection, incl.
    `recipient_email_enc` decryption).
13. **Server-only modules must begin with `import "server-only"`.** Filename
   convention is `*.server.ts`. See
   [`lib/server/README.md`](../lib/server/README.md) and
   [`lib/repositories/README.md`](../lib/repositories/README.md#implementation-file-naming).

---

## 4. Runtime seams (what swaps when we wire the DB / LLM)

These seams are the only places that move when the back end goes real.

| Seam | What it does today | What replaces it |
|---|---|---|
| `lib/server/auth/current-user.server.ts` | Resolves `{ id, email, name, initials, sendingAccount }` and `OwnerId` from validated `DEV_OWNER_*` env. Mock mode returns `sendingAccount: null`; DB mode reads the owner's primary Gmail account. This is the only owner resolver; DB helpers keep calling synchronous `currentUserIdOrThrow()`, while `/api/session`, Home, Workspace, and Profile await `currentUserOrThrow()`. | Real session cookie / OAuth verification inside this module only. `/api/session` keeps returning `{ user }`; Home, Workspace, and Profile keep rendering the same identity shape; DB helper call sites keep their owner-id contract. |
| `lib/server/oauth/gmail.server.ts` | Full Gmail OAuth start + callback. Start signs an HMAC state cookie and 307s to Google with `openid email gmail.send` scopes. Callback verifies cookie + state, fetches `GOOGLE_TOKEN_ENDPOINT`, decodes id_token for the account email, and persists encrypted refresh-token metadata through `GmailAccountRepository.upsertPrimary`. Cookie cleared on every response. No SDK; native `fetch` only. | Same seam swap to real auth replacing `currentUserIdOrThrow()`; no other change needed. |
| `lib/server/remaster-overview/index.server.ts` | Composes `getPeoplePayload()` and `getDeliveryHistory()` into derived `RemasterDashboardOverview` accounts, contacts, and activities. Home consumes the overview directly; People consumes a compatibility view that also carries the legacy payload for drawer/add continuity. Storage stays person-centered underneath. | Move Workspace and History to the compatibility model, then later replace the derivation with native account/contact/activity storage. |
| `lib/server/people-payload/index.server.ts` | Dispatches to mock by default, or DB when `KEEPSAKE_DATA_SOURCE=db`. | Later auth replaces `DEV_OWNER_ID`; route/page imports stay the same. |
| `lib/server/people-payload/mock.server.ts` | `getMockPeoplePayload()` reads `peoplePayload()` from `lib/mock.ts`. | Kept as fallback until all runtime paths are DB-backed. |
| `lib/server/people-payload/db.server.ts` | `getDbPeoplePayload()` resolves dev owner, opens transaction, calls `PeopleRepository.listWithRelations(ownerId)`. | Real auth replaces `auth/current-user.server.ts`; repository call remains. |
| `lib/server/people-create/index.server.ts` | Validates Add Person input, derives avatar/known-fact defaults, and dispatches to mock or DB. Mock returns a `local-*` `Person` for browser-local preview persistence; DB writes through `PeopleRepository.create`. | Future People edit/archive/date routes land as sibling seams; `app/api/people/route.ts` stays parse → delegate → response. |
| `lib/server/people-create/db.server.ts` | Resolves owner, opens `transaction(ownerId, …)`, calls `PeopleRepository.create`, and maps FK misses to 400 `invalid_reference`. | Real auth replaces `auth/current-user.server.ts`; repository call remains. |
| `lib/server/delivery-history/index.server.ts` | Dispatches to mock by default, or DB when `KEEPSAKE_DATA_SOURCE=db`. | Later auth replaces `DEV_OWNER_ID`; `app/history/page.tsx` keeps calling only the server helper. |
| `lib/server/delivery-history/mock.server.ts` | `getMockDeliveryHistory()` reads `deliveries` from `lib/mock.ts`. | Kept as fallback until all runtime paths are DB-backed. |
| `lib/server/delivery-history/db.server.ts` | `getDbDeliveryHistory()` resolves dev owner, opens transaction, calls `DeliveryRepository.listByMonth(ownerId, { limit: 50 })`. | Same repo composition with real auth. History DB mode is read-only; enqueue/send/webhook/worker paths remain unimplemented. |
| `lib/server/draft-service/index.server.ts` | Dispatches draft generation, latest-draft restore, and version-history reads to mock by default, or DB when `KEEPSAKE_DATA_SOURCE=db`. | Later auth/LLM swaps stay behind this seam; route imports stay the same. |
| `lib/server/draft-service/mock.server.ts` | Validates/hydrates mock context and calls the mock generator. Does not write DB. Latest restore misses and version history returns an empty list. | Kept as fallback until all runtime paths are DB-backed. |
| `lib/server/draft-service/db.server.ts` | Resolves dev owner and opens one transaction. For POST it hydrates DB context, computes a prompt HMAC, checks `DraftRepository.findByPromptHash`, then saves misses via `DraftRepository.save`; for GET latest it validates the same person/occasion context and calls `DraftRepository.getLatestFor`; for versions it validates context, reads `DraftRepository.listForPerson`, filters to the resolved occasion, and slices the safe limit. | Same orchestration with real auth and a future LLM generator. |
| `lib/server/draft-context/index.server.ts` | Dispatches to mock by default, or DB when `KEEPSAKE_DATA_SOURCE=db`. | Later auth replaces `DEV_OWNER_ID`; route import stays the same. |
| `lib/server/draft-context/mock.server.ts` | `resolveMockDraftContext(input)` validates + finds person/relationship/culture/occasion in the mock store. | Kept as fallback until all runtime paths are DB-backed. |
| `lib/server/draft-context/db.server.ts` | `resolveDbDraftContext(input)` resolves the owner, opens a transaction, hydrates person/catalog/occasion via repos under RLS. Also exposes `resolveDbDraftContextInTx` so draft persistence can reuse the outer transaction. | Same repo composition with real auth. |
| `lib/server/draft-generator/mock.server.ts` | `createMockDraftGenerator().generate(ctx)` builds a `MessageDraft` from `baseRecipe` + `applyInstruction` — pure data-driven heuristics. Also exports `deterministicRecipe(ctx)` for the LLM adapter to reuse for `attachedCard` + `quickActions`. | Kept as the always-available fallback (and as the deterministic recipe source) when `KEEPSAKE_DRAFT_SOURCE=mock`. |
| `lib/server/draft-generator/index.server.ts` | `getDraftGenerator()` returns the configured generator; reads `KEEPSAKE_DRAFT_SOURCE` (`mock` default, `openai` opt-in), caches the constructed instance, and throws `DraftGeneratorError("misconfigured", …)` for unknown sources. Independent of `KEEPSAKE_DATA_SOURCE`. | Add more provider adapters here; route imports stay the same. |
| `lib/server/draft-generator/openai.server.ts` | `createOpenAIDraftGenerator()` validates `KEEPSAKE_DRAFT_API_KEY` / `KEEPSAKE_DRAFT_API_BASE` / `KEEPSAKE_DRAFT_MODEL` at construction. `generate(ctx)` POSTs an OpenAI-compatible chat-completions request, expects a JSON object with the constrained MessageDraft fields, validates the tone against the union, and reuses `deterministicRecipe(ctx)` for the card + quick actions. Normalises every failure into `DraftGeneratorError("misconfigured" \| "unavailable" \| "malformed_response", …)`. | Swap for a streaming or provider-specific client without touching the route. |
| `lib/server/delivery-send/index.server.ts` | Dispatches `enqueueDelivery(input)` to mock by default, or DB when `KEEPSAKE_DATA_SOURCE=db`. Returns a `SendBoundaryResult` discriminated union the route maps to HTTP status. | Real auth replaces `currentUserIdOrThrow()`; future Gmail send worker reads queued rows out-of-band. The route signature does not move. |
| `lib/server/delivery-send/mock.server.ts` | Shared `validateRequest` (UUIDs + channel) and `enqueueMockDelivery` that returns a synthetic `QueuedDelivery`. | Kept as fallback until all runtime paths are DB-backed. |
| `lib/server/delivery-send/db.server.ts` | `enqueueDbDelivery` resolves the owner, opens one transaction, reuses `resolveDbDraftContextInTx` for person/occasion ownership, enforces the email sender precondition via `GmailAccountRepository.getPrimary`, looks up the latest draft, and calls `DeliveryRepository.enqueue`. No Gmail call; row inserted with `status='queued'` and `sent_at=NULL`. | Same orchestration with real auth; a future Gmail worker drains queued rows and updates status. |
| `lib/server/delivery-webhook/ingest.server.ts` | `ingestDeliveryWebhookEvent(input)` validates the provider-agnostic event (provider ∈ {gmail, mock}; event ∈ {delivered, opened, failed}) and dispatches by `KEEPSAKE_DATA_SOURCE`. Identity = `providerMessageId`; never reads current user. | A future Gmail push subscription wires `provider: "gmail"` directly into this seam; no route signature change. |
| `lib/server/channels/mock-inbound.server.ts` | DB-backed mock provider adapter. Validates `externalUserId` + `text`, requires `KEEPSAKE_DATA_SOURCE=db`, resolves the active `channel_accounts` row with `workerTransaction` + `ChannelAccountRepository.findByProviderUser("mock", externalUserId)`, returns `needs_link` + `reviewUrl: "/profile#command-channels"` for missing/revoked accounts, and (after owner resolution) hands off to `handleOwnerCommand(ownerId, event)` for the actual reply. Dev-only response echoes `ownerId`; real provider routes must not. | WhatsApp / Telegram / Slack routes add provider signature verification + dedupe, then normalise into the same service/router pattern and render `reviewUrl` as the web execution link. |
| `lib/server/channels/command-service.server.ts` | Owner-scoped channel read path (P8-E). `handleOwnerCommand(ownerId, event)` calls `routeCommandEvent` for intent classification; for `relationship_followup_query` it opens `transaction(ownerId, …)`, calls `PeopleRepository.listWithRelations`, filters upcoming occasions (`daysUntil >= 0 && <= 30`, top 3 ascending), and renders a real-name reply. All other intents pass through untouched. Read-only on owner data; **never** creates a draft, enqueues a delivery, calls Gmail, or talks to a real provider. | Future LLM intent classifier slots in behind `routeCommandEvent`; future reminder outbound calls a parallel `handleOwnerReminder(ownerId, …)` that shares the same `transaction(ownerId, …)` shape. |
| `lib/server/channel-accounts/profile.server.ts` | Profile-facing read + mock/Telegram mutation seam for `channel_accounts` (P8-F/P8-I/P8-J). `getProfileChannelAccounts()` returns `{ dataSource: "mock"|"db", accounts, telegramStartLink }` — mock mode is an empty list so the UI renders a placeholder rather than fabricating rows. DB mode renders a signed Telegram start link when configured, and keeps `linkMockChannelAccount({ externalUserId, externalThreadId?, displayName? })`, `linkTelegramChannelAccount({ externalUserId, externalThreadId?, displayName? })`, and `revokeChannelAccount({ accountId })` as manual fallback/operator routes. All mutations are DB-mode only and resolve the caller with `currentUserIdOrThrow()` BEFORE any DB call (no sessionless mutation). Transaction model: `getProfileChannelAccounts` + `revokeChannelAccount` use `transaction(ownerId, …)` (request-path pool under RLS, with explicit `WHERE owner_id` in SQL as defence in depth); manual link delegates to `ChannelAccountRepository.link`, whose runtime elevates to `workerTransaction` (BYPASSRLS) so the cross-owner conflict on the unique `(provider, external_user_id)` index can be detected atomically — owner_id is enforced in SQL via `ON CONFLICT … DO UPDATE … WHERE owner_id = $caller`. Maps repo `cross_owner_conflict` → 409, unknown / cross-owner revoke → 404, unexpected errors → 500 with a generic detail (raw causes go to `console.error`). Read/write on metadata only — never creates a draft, enqueues a delivery, calls Gmail, or talks to a real provider. | Real WhatsApp / Slack link flows and Telegram one-time nonce persistence are future; the manual Telegram form stays as the local/early ops fallback. |
| `lib/server/delivery-webhook/mock.server.ts` | Mock dispatch — no `deliveries` rows exist, so every well-formed event resolves to `delivery_not_found`. Keeps the contract exercisable without Postgres. | Deleted when DB is the only source. |
| `lib/server/delivery-webhook/db.server.ts` | `ingestWebhookEventDb` runs under `workerTransaction` (BYPASSRLS), looks up the row via `DeliveryRepository.findByProviderMessageId(providerMessageId)`, maps the event to a target `DeliveryStatus`, and calls `DeliveryRepository.markStatus({ deliveryId, status, providerStatus?, deliveredAtISO?, openedAtISO?, failureReason? })`. `opened` events also pass `deliveredAtISO` so the row picks up a delivered timestamp even when the provider skipped the delivered event. | Future per-provider HMAC verification + retry queue layer on top; the seam contract stays. |

The route handlers do not move.

---

## 5. Replacement plan

| Current module | Future replacement | What should NOT change | Tests guarding it |
|---|---|---|---|
| `lib/server/auth/current-user.server.ts` | Real auth-backed current user resolver | `currentUserIdOrThrow(): OwnerId`; `currentUserOrThrow()` returning `{ id, email, name, initials, sendingAccount }`; typed unauthenticated vs misconfigured errors | `pnpm test:auth`, `pnpm test:home`, `pnpm test:workspace`, `pnpm test:profile`, `pnpm test:boundaries` |
| `app/api/session/route.ts` | Unchanged route contract over real auth | Thin shape: call auth service → return `{ user }`; 401 for missing auth; 500 for invalid server auth config; no DB/cookies/OAuth/Gmail writes in the route | `pnpm test:auth` |
| `app/api/oauth/gmail/start/route.ts` and `app/api/oauth/gmail/callback/route.ts` | Unchanged route contract over real Gmail OAuth | Thin shape: auth → delegate to `oauth/gmail.server.ts` → JSON failure or redirect; route files do not exchange tokens, write DB, or update `sendingAccount` directly | `pnpm test:oauth`, `pnpm test:boundaries` |
| `app/api/gmail/disconnect/route.ts` | Unchanged thin POST route | auth → `disconnectGmailAccount(ownerId, origin)` from `lib/server/gmail-account/disconnect.server.ts` → `303` to `/profile`; idempotent; no SQL in the route. The helper reuses the auth seam's strict `dataSource()`, so a misconfigured `KEEPSAKE_DATA_SOURCE` maps to 500 with the existing auth-misconfigured error shape (no new contract). | `pnpm test:db:current-user`, `pnpm test:profile`, `pnpm test:gmail-disconnect`, `pnpm test:boundaries` |
| `app/api/auth/signout/route.ts` | Stays a thin POST route owned by the auth seam | clears `keepsake_session` (`Max-Age=0`) and 303s to `/signin` — or to a safe relative `?returnTo=…`, falling back to `/signin` (NOT `/`) on anything unsafe. Does not read current user, touch DB, revoke the Google grant, or disconnect Gmail. Profile's sign-out row is a plain `<form method="post" action="/api/auth/signout">`. | `pnpm test:auth` (`test-signout.mjs`: 303 + cleared cookie + safe returnTo + profile form HTML + post-signout redirect + no-aux-env) |
| `app/api/webhooks/deliveries/route.ts` | Stays thin; delegates to `lib/server/delivery-webhook/ingest.server.ts` | env `DELIVERY_WEBHOOK_SECRET` + header `x-keepsake-webhook-secret` gate. JSON body → `ingestDeliveryWebhookEvent`; success → 200 `{ ok, deliveryId, status, updated }`; lookup miss → 404 `delivery_not_found`; shape miss → 400 `invalid_event` (+ detail). No SQL in the route; never reads current user; the provider's `providerMessageId` is the identity. | `pnpm test:webhook-deliveries` (default 14-assertion smoke), `pnpm test:db:webhook-deliveries` (36-assertion DB smoke: transitions + no-downgrade + 404 + secret gate) |
| `lib/server/oauth/gmail.server.ts` | Real Gmail OAuth service | `startGmailOAuth` and `completeGmailOAuth` result union; start can redirect to Google when configured; callback still 400 invalid/provider-denied or 501 until token exchange/state validation are wired; account persistence only through `GmailAccountRepository`; no send/enqueue behavior | `pnpm test:oauth` |
| `lib/repositories/gmail-accounts.server.ts` | Auth/OAuth-facing Gmail account repository | Plaintext refresh token only appears in `GmailAccountUpsertInput`; repo encrypts `refresh_token_enc`; read methods never expose tokens; owner-scoped RLS remains active | `pnpm test:db:gmail-accounts` |
| `lib/server/remaster-overview/index.server.ts` | Keep as the compatibility seam while storage is still person-centered | `getRemasterDashboardOverview()` signature, Home's account/contact/activity framing, and People's `primaryContactId` bridge back to `/workspace?person=...` | `pnpm test:home`, `pnpm test:people` |
| `lib/server/people-payload/index.server.ts` | Keep as dispatcher until mock can be deleted | `getPeoplePayload()` signature; `GET /api/people` returning `PeoplePayload` | `pnpm test:people`, `pnpm test:db:people-route` |
| `lib/server/people-payload/db.server.ts` | Real auth-backed owner resolution instead of `DEV_OWNER_ID` | Repository call and `PeoplePayload` shape | `pnpm test:db:people-route` |
| `lib/server/people-create/index.server.ts` | Keep as dispatcher until mock can be deleted | `POST /api/people` request/error shape; successful response is a `Person` | `pnpm test:db:people`, `pnpm test:db:people-route` |
| `lib/server/people-create/db.server.ts` | Real auth-backed owner resolution instead of `DEV_OWNER_ID` | `PeopleRepository.create(ownerId, input)` inside one transaction | `pnpm test:db:people-route` |
| `lib/server/delivery-history/index.server.ts` | Keep as dispatcher until mock can be deleted | `getDeliveryHistory()` signature; History page receives `Delivery[]`; email/post remain badges rather than separate product modes | `pnpm test:history`, `pnpm test:db:history-route` |
| `lib/server/delivery-history/db.server.ts` | Real auth-backed owner resolution instead of `DEV_OWNER_ID` | Read-only `DeliveryRepository.listByMonth` call; no enqueue/send/webhook/worker behavior | `pnpm test:db:deliveries`, `pnpm test:db:history-route` |
| `lib/server/draft-service/index.server.ts` | Keep as dispatcher until mock can be deleted | `generateDraft(input)`, `getLatestDraft(input)`, and `listDraftVersions(input)` result shapes; routes stay parse/query → delegate → response | `pnpm test:drafts`, `pnpm test:db:drafts-route` |
| `lib/server/draft-service/db.server.ts` | Real auth-backed owner resolution and future LLM generator | One transaction for context resolution + cache lookup + save on POST, context resolution + latest read on GET, and context validation + version list read on `/api/drafts/versions`; prompt HMAC is based on resolved server-side context + instruction + generator id; generator remains mock today | `pnpm test:db:drafts-repository`, `pnpm test:db:drafts-route` |
| `lib/server/draft-context/index.server.ts` | Keep as dispatcher until mock can be deleted | `resolveDraftContext(input)` signature; `DraftContextResolution` shape (`ok:true ∣ ok:false+status+error`); `400 / 404 / 500` boundary | `pnpm test:drafts`, `pnpm test:db:drafts-route` |
| `lib/server/draft-context/db.server.ts` | Real auth-backed owner resolution instead of `DEV_OWNER_ID` | Repo composition only; context shape and error semantics stay stable | `pnpm test:db:drafts-route` |
| `lib/server/draft-generator/mock.server.ts` | LLM-backed implementation of `DraftGenerator` from `lib/server/draft-generator/types.ts` | `generate(ctx): Promise<MessageDraft>` signature; `DraftContext` input shape; `MessageDraft` output (paragraphs plain text, highlights array, attachedCard hints) | `pnpm test:drafts` (`tone = tender-intimate`, `tone = playful`, `tone = warm-festive`, no-Christmas, contains "Selamat Hari Raya") |
| `lib/mock.ts` | Postgres queries via repos; this file is deleted, not migrated | The mock data shape (everything matches `lib/domain.ts`); the catalog ids (`'rel-partner'`, `'chinese'`, etc.) match `db/seed_catalog.sql` | Both smoke tests (any drift surfaces as a contract failure) |
| `app/api/people/route.ts` | Unchanged route boundary | GET imports `getPeoplePayload`; POST parses JSON → `createPersonFromRequest` → 201 `Person` or typed 400/401/500 JSON | `pnpm test:people`, `pnpm test:db:people-route` |
| `app/api/drafts/route.ts` | Unchanged boundary | Thin shape: POST parses JSON → `generateDraft` → JSON; GET parses query → `getLatestDraft` → JSON/204 | `pnpm test:drafts`, `pnpm test:db:drafts-route` |
| `app/api/drafts/versions/route.ts` | Unchanged boundary | Thin shape: GET parses query → `listDraftVersions` → `{ drafts }`; no repo/crypto/mock imports in the route | `pnpm test:drafts`, `pnpm test:db:drafts-route` |
| Pages consuming mock-backed server helpers | Repo-backed server helpers, with client components continuing to receive serializable domain payloads | The current visual contract (the prototype HTML stays the visual source of truth) | none yet — TODO: snapshot or visual diff once we wire repos |

---

## 6. CC / Codex split — suggested

These are tendencies, not rules. The agent that's already loaded a piece
of context is often the right one to keep on it.

### Claude Code (CC) suits

- Page wiring, drawer layout, form components, copy.
- New `lib/server/*.server.ts` seam implementations against an existing
  interface (`PeopleRepository`, `DraftGenerator`).
- Writing or extending `scripts/test-*.mjs` smoke tests.
- Mechanical refactors that span many files (rename, signature change).
- Walkthroughs of existing flows — render an architecture diagram,
  explain why a route is shaped a certain way.

### Codex suits

- Contract reviews — does this PR change `lib/domain.ts` or an API shape?
  Is the migration story documented?
- DB schema edits, RLS policy review, index-justification audits.
- LLM prompt boundary work: prompt template shape, output schema
  validation, eval design (when the generator actually exists).
- Data-model changes that ripple — adding a culture, adding a `Tone`
  variant, splitting `Person` into `Person` + `Contact`.
- Security review of `auth/current-user.server.ts` and
  `crypto/envelope.server.ts` when those land.

When work crosses both categories (e.g. "add Singapore Chinese culture and
wire it into the seed + the generator's greeting fallback"), the seed
table / culture-rule update is Codex-shaped and the generator wiring
update is CC-shaped — split the PR.

---

## 7. Don't do

These are foot-guns that have come up in past designs. They short-circuit
the boundaries the rest of the codebase relies on.

- **Don't import server-only helpers from client components.** Anything
  under `lib/server/` starts with `import "server-only";`. A `"use client"`
  module importing it is a build error in Next, on purpose. If you want
  the data in a client component, route it through `/api/*`.
- **Don't accept `relationship` or `cultureRule` (or `tone` override) from
  the client.** The server reads them from `person.relationshipId` /
  `person.cultureId`. Letting the client name them defeats the point of
  cultural fluency as the moat.
- **Don't put HTML strings in `MessageDraft.paragraphs[].text`.** Plain
  text with a separate `highlights: string[]`. The client renderer
  wraps spans. Same rule for the eventual LLM output schema.
- **Don't promote the card to a primary flow.** Email is the artefact.
  The card is one optional attachment on an email. Workspace shouldn't
  acquire a "card mode" tab; History shouldn't separate "cards" from
  "emails" as the dominant axis.
- **Don't put SQL or DB clients inside `app/` or `components/`.** Routes
  call `lib/server/*.server.ts`; those will call `lib/repositories/*.server.ts`.
  The `app/` and `components/` trees stay framework-only.
- **Don't bypass RLS in request paths.** Worker-only repo methods
  (`DeliveryRepository.nextQueued`, `markStatus`,
  `findByProviderMessageId`) run under a separate role and must not be
  reachable from `app/api/*/route.ts`.
- **Don't treat delivery sending as implemented.** The only runtime delivery
  repository method today is `DeliveryRepository.listByMonth()` for read-only
  History. `enqueue`, send worker drain, provider webhooks, and status updates
  are still deliberately unimplemented.
- **Don't treat People CRUD as complete.** `POST /api/people` can create a
  person and the People page can add one, but update/archive/date management
  are still future slices.
