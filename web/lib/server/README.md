# `lib/server/` — server-only seams and services

Where server-only orchestration lives. This directory keeps `app/` and
`components/` away from `lib/mock.ts`, SQL, crypto, and future auth/LLM
clients. People payload, draft generation orchestration, latest draft restore,
draft version history, draft context, and delivery history now have DB-capable
runtime verticals.
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
├── people-payload/
│   ├── index.server.ts       ← current: mock/db dispatcher
│   ├── mock.server.ts        ← current: mock fallback
│   └── db.server.ts          ← current: DB-backed PeoplePayload
├── delivery-history/
│   ├── index.server.ts       ← current: mock/db dispatcher
│   ├── mock.server.ts        ← current: mock fallback
│   └── db.server.ts          ← current: DB-backed History data
├── draft-context/
│   ├── index.server.ts       ← current: mock/db dispatcher
│   ├── mock.server.ts        ← current: mock fallback
│   └── db.server.ts          ← current: DB-backed DraftContext
├── draft-service/
│   ├── index.server.ts       ← current: mock/db dispatcher for /api/drafts
│   ├── mock.server.ts        ← current: mock POST + latest miss + empty versions
│   ├── db.server.ts          ← current: DB context + draft cache/save/latest/versions
│   └── types.ts              ← draft service contracts
├── draft-generator/
│   ├── types.ts              ← DraftContext / DraftGenerator contracts
│   └── mock.server.ts        ← current: mock MessageDraft generator
├── auth/                     ← current: dev owner seam; future real auth
│   └── current-user.server.ts
├── oauth/                    ← current: provider route contracts only
│   └── gmail.server.ts
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
6. **No domain logic in generic services.** Tone selection, prompt wording,
   relationship-aware fallbacks — those live in the route handler or in
   `draft-generator`. `db/`, `crypto/`, `auth/` stay generic.
7. **Stateless calls.** Services may hold a connection pool or a KMS
   client at module scope, but a single request must not mutate
   module-level state observable to the next request.

## Services

### Current runtime seams

These are the files that should move when the back end goes real. They are
small on purpose.

| Seam | Called by | Today | Future replacement | Guard |
|---|---|---|---|---|
| `auth/current-user.server.ts` | `/api/session`, Home, Workspace, Profile, DB-backed server helpers | Resolves `{ id, email, name, initials, sendingAccount }` from `DEV_OWNER_*`; mock mode returns `sendingAccount: null`, DB mode hydrates it from the owner primary Gmail account; `currentUserIdOrThrow()` remains the synchronous owner-id compatibility helper | Cookie/session/OAuth inside this file only; route, Home, Workspace, Profile, and DB helper contracts stay the same | `pnpm test:auth`, `pnpm test:home`, `pnpm test:workspace`, `pnpm test:profile`, `pnpm test:db:current-user`, `pnpm test:boundaries` |
| `oauth/gmail.server.ts` | `GET /api/oauth/gmail/start`, `GET /api/oauth/gmail/callback` | Defines the Gmail OAuth start/callback contract and returns explicit 501 `not_configured` placeholders once the caller is authenticated. Callback also returns 400 for provider denial or missing `code/state`. | Google authorization URL generation, OAuth state semantics, token exchange, and account persistence through `GmailAccountRepository` over `gmail_accounts`. Route files stay parse/query → auth → delegate → JSON/redirect, and should only apply plain-data redirect/cookie instructions returned by the seam. | `pnpm test:oauth`, `pnpm test:boundaries` |
| `people-payload/index.server.ts` | `GET /api/people`, Home, People | Dispatches by `KEEPSAKE_DATA_SOURCE`: mock by default, DB when set to `db` | Real auth owner resolution; eventually delete mock fallback | `pnpm test:people`, `pnpm test:db:people-route`, `pnpm test:boundaries` |
| `people-payload/mock.server.ts` | `people-payload/index.server.ts` | `peoplePayload()` from `lib/mock.ts` | Deleted when DB is the only source | `pnpm test:people`, `pnpm test:boundaries` |
| `people-payload/db.server.ts` | `people-payload/index.server.ts` | `currentUserIdOrThrow()` + `transaction(ownerId)` + `PeopleRepository.listWithRelations(ownerId)` | Same repository call with real auth | `pnpm test:db:people-route` |
| `delivery-history/index.server.ts` | History | Dispatches by `KEEPSAKE_DATA_SOURCE`: mock by default, DB when set to `db`; `app/history/page.tsx` only calls this server helper | Real auth owner resolution; eventually delete mock fallback | `pnpm test:history`, `pnpm test:db:history-route`, `pnpm test:boundaries` |
| `delivery-history/mock.server.ts` | `delivery-history/index.server.ts` | `deliveries` from `lib/mock.ts` | Deleted when DB is the only source | `pnpm test:history`, `pnpm test:boundaries` |
| `delivery-history/db.server.ts` | `delivery-history/index.server.ts` | `currentUserIdOrThrow()` + `transaction(ownerId)` + `DeliveryRepository.listByMonth(ownerId, { limit: 50 })`; read-only History DB mode | Same repository read with real auth; send/enqueue/webhook/worker remain separate future paths | `pnpm test:db:deliveries`, `pnpm test:db:history-route` |
| `draft-service/index.server.ts` | `GET /api/drafts`, `POST /api/drafts`, `GET /api/drafts/versions` | Dispatches by `KEEPSAKE_DATA_SOURCE`: mock by default, DB when set to `db` | Same route seam with real auth/LLM behind it | `pnpm test:drafts`, `pnpm test:db:drafts-route`, `pnpm test:boundaries` |
| `draft-service/mock.server.ts` | `draft-service/index.server.ts` | Preserves original mock POST behavior: mock context + mock generator, no DB writes. Latest restore returns a miss (`draft:null`) so Workspace falls through to initial generation; version history returns `{ drafts: [] }`. | Deleted when DB is the only source | `pnpm test:drafts`, `pnpm test:boundaries` |
| `draft-service/db.server.ts` | `draft-service/index.server.ts` | `currentUserIdOrThrow()` + one `transaction(ownerId)` for DB context, prompt hash lookup, mock generation on miss, and `DraftRepository.save` on POST; same transaction + context validation + `DraftRepository.getLatestFor` on GET latest restore; context validation + `DraftRepository.listForPerson` for version history | Same orchestration with real auth and a future LLM generator | `pnpm test:db:drafts-repository`, `pnpm test:db:drafts-route` |
| `draft-context/index.server.ts` | `POST /api/drafts` | Dispatches by `KEEPSAKE_DATA_SOURCE`: mock by default, DB when set to `db` | Real auth owner resolution; eventually delete mock fallback | `pnpm test:drafts`, `pnpm test:db:drafts-route`, `pnpm test:boundaries` |
| `draft-context/mock.server.ts` | `draft-context/index.server.ts` | validates ids and builds `DraftContext` from mock finders | Deleted when DB is the only source | `pnpm test:drafts`, `pnpm test:boundaries` |
| `draft-context/db.server.ts` | `draft-context/index.server.ts`, `draft-service/db.server.ts` | `currentUserIdOrThrow()` + `transaction(ownerId)` + People/Catalog repo hydration; also exposes an in-transaction resolver for draft persistence | Same repository composition with real auth | `pnpm test:db:drafts-route` |
| `draft-generator/mock.server.ts` | `POST /api/drafts` | mock recipe + instruction rewrite to `MessageDraft` | LLM-backed `DraftGenerator` implementation | `pnpm test:drafts` |

The `app/` tree should not import `lib/mock.ts` directly. If a page needs
server data, make the page a server component and call one of these helpers,
passing serializable domain payloads down to client components. If a client
component needs live data, fetch an API route.

### Current OAuth route stubs

Gmail OAuth has a route contract but no provider implementation yet:

```text
GET /api/oauth/gmail/start
GET /api/oauth/gmail/callback
```

Both routes are `force-dynamic`. They authenticate through
`currentUserIdOrThrow()`, delegate to `oauth/gmail.server.ts`, and return JSON
failures today:

- missing dev auth → `401 { error: "Unauthenticated" }`
- invalid dev auth → `500 { error: "Auth is misconfigured" }`
- start route with valid auth → `501 { code: "not_configured", ... }`
- callback with provider `error` → `400 { code: "provider_error", ... }`
- callback missing `code` or `state` → `400 { code: "invalid_callback", ... }`
- callback with `code` + `state` but no implementation → `501 { code: "not_configured", ... }`

The stubs deliberately do not read Google env vars, create OAuth state,
exchange tokens, write Gmail account rows, enqueue sends, or update
`CurrentUser.sendingAccount`. The next implementation pass should keep those
provider operations behind the `oauth/gmail.server.ts` seam while keeping
`Request` / `Response` types in route handlers.

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

`/api/people`, Home, People, `/api/drafts`, `/api/drafts/versions`, and
History delivery reads can now reach this DB layer when
`KEEPSAKE_DATA_SOURCE=db`. The default remains mock so local UI work does not
require Postgres, and draft generation itself is still handled by
`draft-generator/mock.server.ts`.

For `/api/drafts`, the route remains deliberately thin: parse the JSON body,
call `generateDraft(input)`, then return its `MessageDraft`. The default mock
branch preserves the old resolver + mock generator path and does not write
DB rows. The DB branch resolves context, computes a stable prompt HMAC from
server-side inputs plus `userInstruction` and the mock generator identity,
checks `message_drafts`, and saves cache misses. The client contract is still
only `{ personId, occasionId, userInstruction }`; relationship, cultureRule,
and tone are server-authoritative and are never read from client overrides.

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
`getDeliveryHistory()`. In DB mode that helper opens a user-scoped
transaction and returns decrypted `Delivery[]` rows from
`DeliveryRepository.listByMonth(ownerId, { limit: 50 })`. This is read-only:
enqueue, send workers, provider webhooks, and status updates are not wired to
the app yet.

`DeliveryRepository` currently has only one runtime implementation method:
`listByMonth`. The write/worker surface declared in the interface
(`enqueue`, `markStatus`, `findByProviderMessageId`, `nextQueued`) still
throws `not implemented` in the Postgres implementation. No send, enqueue,
provider webhook, or delivery worker path is wired by the drafts cache work.

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

### `draft-generator/generator.server.ts`

**Purpose.** Turn `{ person, relationship, culture, occasion, userInstruction }`
into the fields a `MessageDraft` needs. Today's mock generator lives at
`draft-generator/mock.server.ts`; a real implementation can sit next to it
when the LLM lands.

**Likely surface.**

```ts
export interface DraftContext {
  person: Person;
  relationship: Relationship;
  cultureRule: CultureRule;
  occasion: OccasionNode | null;
  userInstruction: string;          // "" → initial draft
}

export interface DraftGenerator {
  generate(input: DraftContext): Promise<MessageDraft>;
}
```

**Where called.** Only `/api/drafts` POST, through `draft-service`.
Composed alongside
`PeopleRepository.findById`, `CatalogRepository.getRelationship/getCulture`,
`DraftRepository.findByPromptHash`, `DraftRepository.save`.

**Why this lives in `lib/server/`, not `lib/repositories/`.** The repo
layer persists; this layer thinks. The mock generator that ships today,
and the LLM client that ships next, both implement the same
`DraftGenerator` interface — the route handler doesn't care which one is
wired.

**Provenance + caching.** The repository save input carries `modelProvider`,
`modelVersion`, and `promptHash`. `draft-service/db.server.ts` supplies those
when it persists cache misses; the public draft returned to the UI remains
the `MessageDraft` shape.

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
  ├─ delivery-history/index.server.ts
  │   ├─ mock.server.ts  → lib/mock.ts deliveries          (default)
  │   └─ db.server.ts    → auth/current-user
  │                         db/transaction
  │                         DeliveryRepository.listByMonth (KEEPSAKE_DATA_SOURCE=db)
  │
  └─ render existing History UI from Delivery[]
```

The DB branch is intentionally only a read path over sent deliveries.
`app/history/page.tsx` does not import repositories, SQL helpers, or mock data
directly. The future `DeliveryRepository.enqueue`, `markStatus`,
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
