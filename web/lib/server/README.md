# `lib/server/` — server-only seams and services

Where server-only orchestration lives. This directory keeps `app/` and
`components/` away from `lib/mock.ts`, SQL, crypto, and future auth/LLM
clients. People payload, draft generation orchestration, draft context, and
delivery history now have DB-capable runtime verticals. Draft generation is
still mock-backed; only DB mode persists/caches generated message drafts.

The rule is simple: framework code calls `lib/server/*`; `lib/server/*`
dispatches to mocks or repositories/services without leaking that choice into
`app/`.

## What lives here

Each service is a single concern. The seams, dev auth owner resolver, crypto
envelope helper, and DB transaction helper that exist now are real code;
production auth/KMS remain later passes.

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
│   ├── mock.server.ts        ← current: original mock-only route behavior
│   ├── db.server.ts          ← current: DB context + draft cache/save
│   └── types.ts              ← DraftServiceResult contract
├── draft-generator/
│   ├── types.ts              ← DraftContext / DraftGenerator contracts
│   └── mock.server.ts        ← current: mock MessageDraft generator
├── auth/                     ← current: dev owner seam; future real auth
│   └── current-user.server.ts
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
| `people-payload/index.server.ts` | `GET /api/people`, Home, People | Dispatches by `KEEPSAKE_DATA_SOURCE`: mock by default, DB when set to `db` | Real auth owner resolution; eventually delete mock fallback | `pnpm test:people`, `pnpm test:db:people-route`, `pnpm test:boundaries` |
| `people-payload/mock.server.ts` | `people-payload/index.server.ts` | `peoplePayload()` from `lib/mock.ts` | Deleted when DB is the only source | `pnpm test:people`, `pnpm test:boundaries` |
| `people-payload/db.server.ts` | `people-payload/index.server.ts` | `currentUserIdOrThrow()` + `transaction(ownerId)` + `PeopleRepository.listWithRelations(ownerId)` | Same repository call with real auth | `pnpm test:db:people-route` |
| `delivery-history/index.server.ts` | History | Dispatches by `KEEPSAKE_DATA_SOURCE`: mock by default, DB when set to `db`; `app/history/page.tsx` only calls this server helper | Real auth owner resolution; eventually delete mock fallback | `pnpm test:history`, `pnpm test:db:history-route`, `pnpm test:boundaries` |
| `delivery-history/mock.server.ts` | `delivery-history/index.server.ts` | `deliveries` from `lib/mock.ts` | Deleted when DB is the only source | `pnpm test:history`, `pnpm test:boundaries` |
| `delivery-history/db.server.ts` | `delivery-history/index.server.ts` | `currentUserIdOrThrow()` + `transaction(ownerId)` + `DeliveryRepository.listByMonth(ownerId, { limit: 50 })`; read-only History DB mode | Same repository read with real auth; send/enqueue/webhook/worker remain separate future paths | `pnpm test:db:deliveries`, `pnpm test:db:history-route` |
| `draft-service/index.server.ts` | `POST /api/drafts` | Dispatches by `KEEPSAKE_DATA_SOURCE`: mock by default, DB when set to `db` | Same route seam with real auth/LLM behind it | `pnpm test:drafts`, `pnpm test:db:drafts-route`, `pnpm test:boundaries` |
| `draft-service/mock.server.ts` | `draft-service/index.server.ts` | Preserves original mock route behavior: mock context + mock generator, no DB writes | Deleted when DB is the only source | `pnpm test:drafts`, `pnpm test:boundaries` |
| `draft-service/db.server.ts` | `draft-service/index.server.ts` | `currentUserIdOrThrow()` + one `transaction(ownerId)` for DB context, prompt hash lookup, mock generation on miss, and `DraftRepository.save` | Same orchestration with real auth and a future LLM generator | `pnpm test:db:drafts-repository`, `pnpm test:db:drafts-route` |
| `draft-context/index.server.ts` | `POST /api/drafts` | Dispatches by `KEEPSAKE_DATA_SOURCE`: mock by default, DB when set to `db` | Real auth owner resolution; eventually delete mock fallback | `pnpm test:drafts`, `pnpm test:db:drafts-route`, `pnpm test:boundaries` |
| `draft-context/mock.server.ts` | `draft-context/index.server.ts` | validates ids and builds `DraftContext` from mock finders | Deleted when DB is the only source | `pnpm test:drafts`, `pnpm test:boundaries` |
| `draft-context/db.server.ts` | `draft-context/index.server.ts`, `draft-service/db.server.ts` | `currentUserIdOrThrow()` + `transaction(ownerId)` + People/Catalog repo hydration; also exposes an in-transaction resolver for draft persistence | Same repository composition with real auth | `pnpm test:db:drafts-route` |
| `draft-generator/mock.server.ts` | `POST /api/drafts` | mock recipe + instruction rewrite to `MessageDraft` | LLM-backed `DraftGenerator` implementation | `pnpm test:drafts` |

The `app/` tree should not import `lib/mock.ts` directly. If a page needs
server data, make the page a server component and call one of these helpers,
passing serializable domain payloads down to client components. If a client
component needs live data, fetch an API route.

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

`/api/people`, Home, People, `/api/drafts`, and History delivery reads can
now reach this DB layer when `KEEPSAKE_DATA_SOURCE=db`. The default remains
mock so local UI work does not require Postgres, and draft generation itself
is still handled by `draft-generator/mock.server.ts`.

For `/api/drafts`, the route remains deliberately thin: parse the JSON body,
call `generateDraft(input)`, then return its `MessageDraft`. The default mock
branch preserves the old resolver + mock generator path and does not write
DB rows. The DB branch resolves context, computes a stable prompt HMAC from
server-side inputs plus `userInstruction` and the mock generator identity,
checks `message_drafts`, and saves cache misses. The client contract is still
only `{ personId, occasionId, userInstruction }`; relationship, cultureRule,
and tone are server-authoritative and are never read from client overrides.

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

**Purpose.** Resolve the authenticated `OwnerId`. Today this is a dev-only
seam that reads `DEV_OWNER_ID`; later it becomes the only place in the
codebase that reads cookies / `Authorization` headers and verifies session
tokens.

**Likely surface.**

```ts
export function currentUserId(req: Request): Promise<OwnerId | null>;
export function currentUserIdOrThrow(req: Request): Promise<OwnerId>;
                                       // throws RepoError { kind: "permission-denied" }
                                       // — route handler maps to 401
```

**Where called.** Every `app/api/*/route.ts`, exactly once per request,
as the first line of the handler. Server components that need the user
call it via a thin Server Action wrapper.

**Provider choices to make later.** NextAuth / Auth.js vs. roll-our-own
session table vs. Clerk / Supabase Auth. Decision deferred; the
`Promise<OwnerId | null>` surface is provider-agnostic.

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
  └─ draft-service/index.server.ts
     └─ mock.server.ts
        ├─ draft-context/mock.server.ts
        └─ draft-generator/mock.server.ts
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
