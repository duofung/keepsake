# `lib/repositories/` — DB access layer

The boundary between Postgres and the rest of the app. Most files here are
still TypeScript interface declarations that compile against
[`lib/domain.ts`](../domain.ts) and pair with [`db/schema.sql`](../../db/schema.sql).
The first real implementations are `catalog.server.ts` and the read side of
`people.server.ts`; the remaining repo methods will follow the same pattern
as they land.

## What lives here

| File | Role |
|---|---|
| [`README.md`](./README.md) | This file. The architectural contract. |
| [`index.ts`](./index.ts) | Type-only barrel. Re-exports the four interfaces and the plumbing types from `types.ts`. **Never** re-exports runtime values. |
| [`types.ts`](./types.ts) | Shared types: `OwnerId`, `Tx`, `RepoError`, input shapes for write methods. No business types. |
| [`catalog.ts`](./catalog.ts) | `CatalogRepository` — catalog access to `relationships` + `cultures`. Relationships are owner-aware because user-custom rows share the table with system presets. |
| [`catalog.server.ts`](./catalog.server.ts) | `PgCatalogRepository` — first server-only runtime implementation, backed by `pg` through `lib/server/db/transaction.server.ts`. |
| [`people.ts`](./people.ts) | `PeopleRepository` — per-user CRUD over `people` + `occasion_nodes`. |
| [`people.server.ts`](./people.server.ts) | `PgPeopleRepository` — read-only runtime implementation for people + occasions, including encrypted columns via `lib/server/crypto/envelope.server.ts`. Write methods intentionally throw for now. |
| [`drafts.ts`](./drafts.ts) | `DraftRepository` — persistence for `message_drafts`. |
| [`deliveries.ts`](./deliveries.ts) | `DeliveryRepository` — `deliveries` reads + the send/webhook write paths. |

### Implementation file naming

Interface files are type-only. Runtime implementation files must be named
`<repo>.server.ts` — e.g. `catalog.server.ts`, `people.server.ts`,
`drafts.server.ts`. Each implementation file must also start with:

```ts
import "server-only";
```

The filename is the human convention; `server-only` is the build-time guard
that makes a `"use client"` import fail.

The type-only files (`catalog.ts`, `people.ts`, …) and the `index.ts`
barrel stay name-as-is — they're safe to import from anywhere because they
compile away. The split is:

```
catalog.ts            ← interface,  importable from anywhere
catalog.server.ts     ← class impl, imports "server-only"
index.ts              ← type-only barrel, importable from anywhere
```

Route handlers and `lib/server/` services import the `.server.ts` files
directly; nothing else in the app should.

## Boundary rules

1. **Server-only.** Nothing under `lib/repositories/` may be imported from a
   `"use client"` module. The directory exports `interface`s — pure types,
   so it cannot accidentally bundle DB credentials into the client — but the
   rule is policy, not just mechanics.
2. **Plaintext in, plaintext out.** Every interface speaks `domain.ts` types
   (`Person`, `MessageDraft`, …). `bytea` columns, envelope nonces, and the
   per-user DEK never cross this boundary. Repositories are the only place
   that encrypts and decrypts.
3. **`ownerId` is always an explicit argument for user-visible rows.** RLS in
   Postgres already enforces it; repeating the check in TypeScript is defence
   in depth and makes call sites self-documenting. The only exceptions are
   truly global culture reads and worker/webhook methods that run under a
   privileged role.
4. **No HTTP concerns.** Repositories receive resolved `ownerId`/inputs; they
   never read `Request` headers or set cookies. The route handler in
   `app/api/*/route.ts` is the only layer that knows about HTTP.
5. **No LLM concerns.** `DraftRepository.save()` persists a `MessageDraft`
   the route already has. The eventual `DraftGenerator` (LLM call) is a
   separate service composed alongside the repo, not inside it.
6. **No catalog leakage.** Methods that need a `Relationship` or `CultureRule`
   call `CatalogRepository.get…()`; they don't accept those types from the
   client. This locks in the server-authoritative draft contract.

## Encryption boundary

Columns marked `🔒` in [`db/schema.sql`](../../db/schema.sql) cross this
boundary exactly twice:

```
caller     ─ plaintext ─►  Repo.write  ─ ciphertext ─►  Postgres
caller  ◄─ plaintext ─    Repo.read   ◄─ ciphertext ─   Postgres
```

The repo holds a reference to an injected `Crypto` service (per-user DEK,
KMS-wrapped — see [`docs/DB_SCHEMA.md`](../../docs/DB_SCHEMA.md) §5). That
service is not modelled here; the repo's public surface stays plaintext.

## Transactions

Composite operations (draft generation + persistence, send + delivery row)
need to be atomic. The pattern is a UnitOfWork passed as an optional last
argument:

```ts
await db.transaction(async (tx) => {
  const person = await people.findById(ownerId, personId, tx);
  const draft  = await drafts.save(ownerId, generated, tx);
  await deliveries.enqueue(ownerId, { draftId: draft.id, ... }, tx);
});
```

Every repository method accepts an optional `tx?: Tx`. Omitting it means
"run in your own implicit transaction" — cheaper for one-shot reads.

## The four repositories

### CatalogRepository

Runtime implementation: `catalog.server.ts`. It is intentionally not used
by the app yet; mock-backed server seams still power current routes/pages.
`pnpm test:db:catalog` verifies mapping and RLS behavior against temporary
Postgres.

Catalog reads. `cultures` are global today. `relationships` are owner-aware
because the same table holds system rows (`owner_id IS NULL`) and future
user-custom rows.

| Method | Returns | Caller |
|---|---|---|
| `listRelationships(ownerId)` | `Relationship[]` | `/api/people` GET (server) |
| `listCultures()` | `CultureRule[]` | `/api/people` GET (server) |
| `getRelationship(ownerId, id)` | `Relationship \| null` | `/api/drafts` POST (internal) |
| `getCulture(id)` | `CultureRule \| null` | `/api/drafts` POST (internal) |

### PeopleRepository

Runtime implementation: `people.server.ts` for read methods only. It is not
used by the app yet; mock-backed server seams still power current
routes/pages. `pnpm test:db:people` verifies decryption, RLS behavior,
derived `nextOccasionId` / `isPrimary`, and `PeoplePayload` shape against
temporary Postgres.

Per-user. All methods take `ownerId: OwnerId` as the first argument and
return decrypted domain types. Occasion CRUD lives here because every
occasion belongs to a person — a `personId` lookup already proves ownership.

| Method | Returns | Caller |
|---|---|---|
| `listForOwner(ownerId)` | `Person[]` | `/api/people` GET (server) |
| `listWithRelations(ownerId)` | `PeoplePayload` | `/api/people` GET — single batched query producing the full payload |
| `findById(ownerId, personId)` | `Person \| null` | `/api/drafts` POST (internal); future drawer GET |
| `create(ownerId, input)` | `Person` | Future "Add someone" (route TBD) |
| `update(ownerId, personId, patch)` | `Person` | Future drawer edit |
| `softDelete(ownerId, personId)` | `void` | Future drawer delete |
| `listOccasions(ownerId, personId)` | `OccasionNode[]` | Drawer load (internal) |
| `findOccasionForPerson(ownerId, personId, occasionId)` | `OccasionNode \| null` | `/api/drafts` POST (internal) when `occasionId !== null` |
| `nextOccasionFor(ownerId, personId)` | `OccasionNode \| null` | Resolves `Person.nextOccasionId` at read time |
| `occasionsComingUp(ownerId, withinDays)` | `OccasionNode[]` | Home "dates coming up" count, scheduler queries |
| `upsertOccasion(ownerId, personId, input)` | `OccasionNode` | Future drawer / first-run setup |
| `removeOccasion(ownerId, occasionId)` | `void` | Future drawer |

### DraftRepository

Per-user. Storage and cache lookup for `message_drafts`. The LLM call
itself is **not** here — `save()` takes an already-formed `MessageDraft`.

| Method | Returns | Caller |
|---|---|---|
| `findByPromptHash(ownerId, promptHash)` | `MessageDraft \| null` | `/api/drafts` POST — cache lookup before LLM |
| `getLatestFor(ownerId, personId, occasionId)` | `MessageDraft \| null` | Future workspace reload — pick up where the user left off |
| `save(ownerId, input)` | `MessageDraft` | `/api/drafts` POST — after generation |
| `listForPerson(ownerId, personId, limit)` | `MessageDraft[]` | Future "draft history" view (out of MVP scope) |

### DeliveryRepository

Per-user reads + write paths shared with workers.

| Method | Returns | Caller |
|---|---|---|
| `listByMonth(ownerId, options)` | `Delivery[]` | Future `/api/deliveries` GET → History page |
| `enqueue(ownerId, input)` | `Delivery` | Future `/api/deliveries` POST when user clicks Send / Mail |
| `markStatus(deliveryId, status, providerMessageId?)` | `void` | Future webhook (`/api/webhooks/email`, postal vendor) |
| `findByProviderMessageId(providerMessageId)` | `Delivery \| null` | Webhook ingest — **no `ownerId`** because providers don't know it; the row's own `owner_id` is the auth proof. |
| `nextQueued(limit)` | `DeliveryQueueItem[]` | Send worker — drains `status = 'queued'`. Privileged role, bypasses user RLS. |

## What stays in `domain.ts` vs `types.ts`

`domain.ts` is the persistent + API contract: `Person`, `OccasionNode`,
`MessageDraft`, `Delivery`, `Relationship`, `CultureRule`.

`lib/repositories/types.ts` is repo-internal plumbing:

- `OwnerId` — branded `ID`, makes "I meant person id" vs "I meant owner id" a
  type error at the boundary.
- `Tx` — opaque transaction handle.
- `RepoError` — typed error union (`not-found`, `permission-denied`,
  `conflict`, `unavailable`) so route handlers can map to HTTP codes
  without parsing strings.
- Write input shapes (`PersonCreateInput`, `OccasionUpsertInput`,
  `MessageDraftSaveInput`, `DeliveryEnqueueInput`) — domain types minus
  server-derived fields like `id`, `createdAt`.
- `DeliveryQueueItem` — worker-only shape that includes contact fields needed
  to send. It is deliberately not the public `Delivery` domain type used by
  History.

## Future `/api/drafts` walkthrough

The route stays server-authoritative. The client still sends only
`{ personId, occasionId, userInstruction }`.

```ts
// app/api/drafts/route.ts (future, sketch)
export async function POST(req: Request) {
  const ownerId = await currentUserIdOrThrow(req);   // 401 if missing
  const { personId, occasionId, userInstruction } = await req.json();

  return db.transaction(async (tx) => {
    // 1. Authorise + hydrate person under RLS.
    const person = await people.findById(ownerId, personId, tx);
    if (!person) return notFound();

    // 2. Hydrate the catalog rows referenced by the person.
    const [relationship, culture] = await Promise.all([
      catalog.getRelationship(ownerId, person.relationshipId),
      catalog.getCulture(person.cultureId),
    ]);
    if (!relationship || !culture) return notFound();

    // 3. Hydrate the occasion if one was named.
    const occasion = occasionId
      ? await people.findOccasionForPerson(ownerId, personId, occasionId, tx)
      : null;
    if (occasionId && !occasion) return notFound();

    // 4. Cache lookup.
    const promptHash = hashPromptInputs({
      person, relationship, culture, occasion, userInstruction,
    });
    const cached = await drafts.findByPromptHash(ownerId, promptHash, tx);
    if (cached) return ok(cached);

    // 5. LLM (later). For now this is the mock generator from the current route.
    const generated = await draftGenerator.generate({
      person, relationship, culture, occasion, userInstruction,
    });

    // 6. Persist + return.
    const saved = await drafts.save(ownerId, {
      ...generated,
      personId, occasionId, userInstruction, promptHash,
    }, tx);
    return ok(saved);
  });
}
```

What's notable:

- The client never passes `relationship` or `culture`. They are resolved
  inside the transaction from `person.relationshipId` / `person.cultureId`.
- `people.findById` failing means the caller doesn't own the person → 404,
  not 403. Same response shape for "doesn't exist" vs "exists but yours
  not": don't leak existence.
- `people.findOccasionForPerson` is asked for separately. It must match
  `ownerId + personId + occasionId`, preserving the current mock route's
  cross-person occasion → 404 behavior.
- Caching is keyed by a hash that includes the resolved catalog rows, not
  the raw IDs — so a culture taboo edit invalidates old drafts naturally.

## Other route mappings

| Route | Repo method(s) |
|---|---|
| `GET /api/people` | `people.listWithRelations` (covers people, relationships, cultures, occasions in one payload) |
| `POST /api/drafts` | see above |
| `GET /api/deliveries` *(future)* | `deliveries.listByMonth` |
| `POST /api/deliveries` *(future)* | `drafts.getLatestFor` → `deliveries.enqueue` |
| `POST /api/webhooks/email` *(future)* | `deliveries.findByProviderMessageId` → `deliveries.markStatus` |
| Send worker *(future)* | `deliveries.nextQueued` → mailer SDK → `deliveries.markStatus` |

## Open questions

1. **Connection pooling.** PgBouncer transaction-mode interacts with
   `SET LOCAL app.user_id`: only `SET LOCAL` inside the transaction is
   safe. Encoded as a `Tx` precondition: opening a `Tx` always issues the
   `SET LOCAL` first.
2. **Catalog cache.** Catalog rows change rarely. The implementation can
   fetch once at process start and serve from memory. The interface stays
   `Promise<…>` to keep room for cache invalidation.
3. **Soft-delete vs hard-delete on `people`.** Schema TODO; the interface
   uses `softDelete` to lock in the safer choice.
4. **Background workers.** The send worker bypasses user RLS (`SET ROLE
   keepsake_worker; RESET app.user_id`). Worker-only repo methods are
   explicitly marked above; don't reuse them from request paths.
5. **Validation.** Input objects (`PersonCreateInput`, …) should be parsed
   against runtime schemas (Zod or similar) at the route boundary, not in
   the repo. Repos trust their inputs.
