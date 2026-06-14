# `lib/server/` — server-only services (design only)

Where the side-effectful pieces live: auth resolution, DB transactions,
envelope encryption, the LLM call. **Nothing here is implemented yet.**
This README defines the surface so we can talk about it before we build it.

## What lives here

Each service is a single concern. They compose at the route handler — no
service calls another from inside its own module unless it's a leaf
dependency (e.g. `db/transaction` opens a connection for everyone).

```
lib/server/
├── README.md              ← this file
├── auth/                  ← who is the caller?
│   └── current-user.server.ts
├── db/                    ← how do we open a transaction?
│   └── transaction.server.ts
├── crypto/                ← encrypt/decrypt the 🔒 columns
│   └── envelope.server.ts
└── draft-generator/       ← turn a hydrated context into a MessageDraft
    └── generator.server.ts
```

### Naming

All implementation files use `*.server.ts`. The convention is the same as
[`lib/repositories/`](../repositories/README.md#implementation-file-naming):
the suffix is the human-readable convention, and each implementation file
must also start with `import "server-only";`. The package import is the
build-time guard that makes client-side imports fail rather than leaking
server code into a browser bundle.

Type-only files (signatures, input shapes) drop the `.server` suffix and
sit next to the implementation. Route handlers and tests import from the
plain `.ts` files; the framework links them to the `.server.ts` at build
time.

## Boundary rules

1. **Server-only, by both filename and review policy.** Same rule as repos.
2. **Each service owns one thing.** No "utils" grab-bag; each subfolder is
   its own contract.
3. **No HTTP types past `auth/`.** Only `current-user` knows about
   `Request`, cookies, or session tokens; everyone else takes resolved
   values.
4. **No domain logic in services.** Tone selection, prompt wording,
   relationship-aware fallbacks — those live in the route handler or in
   `draft-generator`. `db/`, `crypto/`, `auth/` stay generic.
5. **Stateless calls.** Services may hold a connection pool or a KMS
   client at module scope, but a single request must not mutate
   module-level state observable to the next request.

## Services

### `auth/current-user.server.ts`

**Purpose.** Resolve the authenticated `OwnerId` from a `Request`. The
only place in the codebase that reads cookies / `Authorization` headers
and verifies session tokens.

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
(see [`lib/repositories/README.md`](../repositories/README.md#future-apidrafts-walkthrough)
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

**Likely surface.**

```ts
export interface CryptoEnvelope {
  encrypt(ownerId: OwnerId, table: string, column: string, plaintext: Uint8Array): Promise<Uint8Array>;
  decrypt(ownerId: OwnerId, table: string, column: string, ciphertext: Uint8Array): Promise<Uint8Array>;
}

export function envelopeFor(ownerId: OwnerId): Promise<CryptoEnvelope>;
                                      // resolves per-user DEK, caches for the request
```

**Where called.** Inside each `*.server.ts` repo implementation, never
from a route handler directly.

**Design points.**
- AES-256-GCM, 12-byte nonce, 16-byte tag. Envelope = `nonce ‖ ct ‖ tag`.
- `AAD = ownerId ‖ table ‖ column`. Copying ciphertext between rows or
  columns fails to decrypt.
- DEK lives in `user_keys`, wrapped by a KMS-held KEK. The KMS provider
  (AWS / GCP / Cloudflare) is the deferred choice; the interface above
  is provider-agnostic.
- Per-request cache: `envelopeFor` resolves the DEK once per request and
  hands the same object to every repo call in that request. Cache lives
  in `AsyncLocalStorage` so it cannot leak across requests.

### `draft-generator/generator.server.ts`

**Purpose.** Turn `{ person, relationship, culture, occasion, userInstruction }`
into the fields a `MessageDraft` needs. Today's mock generator lives at
`app/api/drafts/route.ts`; it moves here when the LLM lands.

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

**Where called.** Only `/api/drafts` POST. Composed alongside
`PeopleRepository.findById`, `CatalogRepository.getRelationship/getCulture`,
`DraftRepository.findByPromptHash`, `DraftRepository.save`.

**Why this lives in `lib/server/`, not `lib/repositories/`.** The repo
layer persists; this layer thinks. The mock generator that ships today,
and the LLM client that ships next, both implement the same
`DraftGenerator` interface — the route handler doesn't care which one is
wired.

**Provenance + caching.** The repository save input still carries
`modelProvider`, `modelVersion`, and `promptHash`. Those are added by the
route/repository composition layer when persistence lands; the public draft
returned to the UI remains the `MessageDraft` shape.

## How the four compose at the `/api/drafts` route

```
POST /api/drafts
  │
  ├─ auth/current-user             → OwnerId        (or 401)
  ├─ db/transaction                ┐ opens a tx, SET LOCAL app.user_id
  │                                │
  │   ├─ PeopleRepository           │ findById, findOccasionForPerson
  │   ├─ CatalogRepository          │ getRelationship, getCulture
  │   ├─ DraftRepository            │ findByPromptHash
  │   ├─ draft-generator            │ generate(...)   ← LLM call (later)
  │   └─ DraftRepository            │ save(...)
  │                                ┘
  └─ crypto/envelope                used inside every repo *.server.ts; the route handler never sees it
```

The client still sends only `{ personId, occasionId, userInstruction }`.
`relationship` and `cultureRule` are resolved server-side from
`person.relationshipId` / `person.cultureId`. Anything that looks like a
client trying to specify a culture or relationship is rejected at
`/api/drafts` request parsing — the route schema does not accept those
fields.

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
4. **Local dev.** During development we want the mock generator without a
   real KMS. `crypto/envelope.server.ts` will accept a `KeyProvider`
   interface; one impl is `KmsKeyProvider`, another is `DevKeyProvider`
   reading a key from `.env.local`. The repo layer doesn't know which.
