# Keepsake — current architecture map

A snapshot of how the codebase looks today, for handing work between Claude
Code, Codex, and humans without re-deriving the layering each time. Pairs
with [`docs/DB_SCHEMA.md`](./DB_SCHEMA.md) (target schema) and the four READMEs
under [`lib/repositories/`](../lib/repositories/README.md), [`lib/server/`](../lib/server/README.md), [`db/`](../db/README.md).

This document is descriptive. When the codebase moves, this file moves
with it. When in doubt, the code wins.

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

This is the stable public session contract. Today `current-user` reads the
dev-only `DEV_OWNER_*` env values and validates UUID/email/name. It does not
touch DB, cookies, OAuth, Gmail, or write paths. Future cookie/OAuth work
replaces the internals of `lib/server/auth/current-user.server.ts`; the route
continues to return `{ user }`.

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
  │                         │      │  draft-generator/mock.server.ts
  │                         │      │
  │                         │      └─ KEEPSAKE_DATA_SOURCE=db
  │                         │           ▼
  │                         │         auth/current-user.server.ts
  │                         │           ▼
  │                         │         db/transaction.server.ts
  │                         │           ▼
  │                         │         draft-context/db.server.ts
  │                         │           ▼
  │                         │         DraftRepository.findByPromptHash(ownerId, hash)
  │                         │           ├─ hit  → return cached MessageDraft
  │                         │           └─ miss → draft-generator/mock.server.ts
  │                         │                    DraftRepository.save(ownerId, draft)
  │                         │      ▼
  │  ◄──── MessageDraft ────┤  NextResponse.json(draft)
  │                         │
```

Route is `force-dynamic`. The generator remains mock-backed in both modes.
Default mock mode is unchanged and does not write DB rows. DB mode resolves
context under RLS, computes a server-side prompt HMAC, caches in
`message_drafts`, and returns the persisted row id.

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
bucket. Mock mode does not persist drafts, so it returns a miss and Workspace
falls through to `POST /api/drafts`.

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

---

## 2. Layer responsibilities

| Layer | Path | Job today | Touches HTTP? | Touches DB? | Touches LLM? |
|---|---|---|---|---|---|
| Pages | `app/page.tsx`, `app/people/`, `app/workspace/`, `app/history/`, `app/profile/` | Render. Home and People call the people-payload dispatcher; Home and Profile read current user identity from the auth seam; History calls the delivery-history dispatcher; Workspace fetches `/api/people`, `/api/drafts`, and `/api/drafts/versions` at runtime; on first open it restores the latest saved draft before generating a new initial draft, then shows a compact DB-backed version strip when multiple saved drafts exist. | yes (client fetch in Workspace) | via server helper when DB mode is enabled | no |
| API routes | `app/api/session/route.ts`, `app/api/people/route.ts`, `app/api/drafts/route.ts`, `app/api/drafts/versions/route.ts` | Parse/return JSON and delegate. `/api/session` exposes the stable `{ user }` contract and maps auth errors; `/api/people` and draft routes can be mock- or DB-backed behind `KEEPSAKE_DATA_SOURCE`; `/api/drafts` still uses the mock generator for POST and has DB latest/version read paths for GET. | yes | people + draft persistence/cache/latest/version reads in DB mode only; `/api/session` never touches DB | no |
| Server services | `lib/server/people-payload/{index,db,mock}.server.ts`, `lib/server/draft-service/{index,db,mock}.server.ts`, `lib/server/draft-context/{index,db,mock}.server.ts`, `lib/server/delivery-history/{index,db,mock}.server.ts`, `lib/server/auth/current-user.server.ts`, `lib/server/db/transaction.server.ts`, `lib/server/crypto/envelope.server.ts`, mock seam for generation | Server-only orchestration. `auth/current-user` is the only current-user / owner resolver; people payload, drafts, draft context, and delivery history are DB-capable runtime verticals; draft generation remains mock-backed. | no | yes in DB mode | no (mock generator only) |
| Mock store | `lib/mock.ts` | In-memory data: 5 people, 7 occasions, 4 cultures, 5 relationships, 4 deliveries + finder helpers. | no | no | no |
| Domain | `lib/domain.ts` | Canonical TypeScript types — the contract between layers and over the wire. No HTML in message content. Card/icon hints are explicit structured fields, not rendered markup. | no | no | no |
| Presentation | `lib/presentation.ts` | Maps `OccasionKind`/`Tone`/`Channel` → icon names, gradients, chip text. UI only. | no | no | no |
| Repository implementations | `lib/repositories/catalog.server.ts`, `lib/repositories/people.server.ts`, `lib/repositories/drafts.server.ts`, `lib/repositories/deliveries.server.ts` | Postgres implementations for catalog, people/occasion reads, message draft persistence/cache, and delivery history reads; people writes and send/webhook/worker methods are intentionally not implemented yet. | no | yes | no |
| DB scripts | `db/schema.sql`, `db/seed_catalog.sql`, `scripts/seed-dev-fixtures.mjs` | Postgres 17 schema + catalog seed + encrypted local-dev fixture seed. | no | yes (manual/dev) | no |
| Smoke tests | `scripts/test-auth-current-user.mjs`, `scripts/test-session-route.mjs`, `scripts/test-home.mjs`, `scripts/test-people.mjs`, `scripts/test-drafts.mjs`, `scripts/test-history.mjs`, `scripts/test-profile.mjs`, DB Docker tests | Default `pnpm test` covers auth/session plus mock HTTP/page contracts, including Home and Profile identity rendering from the auth seam. `pnpm test:db` boots Docker Postgres and covers transaction/repository/fixture/DB-route paths, including DB-backed `/api/people`, `/api/drafts`, and `/history`. | yes (HTTP/page smoke) | DB suite only | no |

---

## 3. Stable contracts (don't break without a heads-up)

These are the load-bearing pieces. Changing them ripples; flag them in the
PR/agent prompt before touching.

1. **`lib/domain.ts` shapes** — `Person`, `OccasionNode`, `MessageDraft`,
   `Delivery`, `Relationship`, `CultureRule`, `PeoplePayload`,
   `DraftRequest`. Every layer round-trips these. The DB schema in
   [`db/schema.sql`](../db/schema.sql) is built around them.
2. **`GET /api/people` response shape** = `PeoplePayload`. Covered by
   `pnpm test:people` (15 assertions).
3. **Current-user shape** = `{ id, email, name, initials }`. `GET /api/session`
   returns it as `{ user }`; `app/page.tsx` renders `name` in the greeting,
   and `app/profile/page.tsx` renders the same shape through the server auth
   helper.
   The route calls only `auth/current-user`, maps missing auth to 401, and
   maps invalid dev env to 500. It is the public contract that real auth will
   preserve. Covered by `pnpm test:auth`, `pnpm test:home`, and
   `pnpm test:profile`.
4. **`POST /api/drafts` request shape** = `{ personId, occasionId, userInstruction }`,
   nothing else. Anything that smells like "let the client name a
   relationship / culture / tone override" violates the server-authoritative
   contract. Extra body fields are ignored by the service and never included
   in DB prompt hashing. Covered by `pnpm test:drafts`.
5. **`POST /api/drafts` response shape** = `MessageDraft`. Same coverage.
6. **`GET /api/drafts` request shape** = query params `{ personId, occasionId? }`.
   It never accepts relationship, culture, tone, or instruction overrides.
   It returns `MessageDraft` on 200 and no body on 204 miss.
7. **`GET /api/drafts/versions` request shape** = query params
   `{ personId, occasionId?, limit? }`. It returns `{ drafts: MessageDraft[] }`
   newest-first. Mock mode returns an empty list; DB mode is read-only and
   validates person/occasion ownership before calling `DraftRepository.listForPerson`.
8. **Culture rules resolve server-side only.** The client never sends a
   `CultureRule`; the server reads it from the person's `culture_id`.
   Implementation in `lib/server/draft-service/` plus
   `lib/server/draft-context/`, backed by mock by default or DB context when
   `KEEPSAKE_DATA_SOURCE=db`.
9. **`MessageDraft.paragraphs[].text` is plain text.** Highlights live in
   `paragraphs[].highlights: string[]`, applied by the client renderer
   (see [`app/workspace/page.tsx`](../app/workspace/page.tsx) — the
   `renderParagraph` helper). No `<span>`, no HTML strings, ever.
10. **Server-only modules must begin with `import "server-only"`.** Filename
   convention is `*.server.ts`. See
   [`lib/server/README.md`](../lib/server/README.md) and
   [`lib/repositories/README.md`](../lib/repositories/README.md#implementation-file-naming).

---

## 4. Runtime seams (what swaps when we wire the DB / LLM)

These seams are the only places that move when the back end goes real.

| Seam | What it does today | What replaces it |
|---|---|---|
| `lib/server/auth/current-user.server.ts` | Resolves `{ id, email, name, initials }` and `OwnerId` from validated `DEV_OWNER_*` env. This is the only owner resolver; DB helpers keep calling `currentUserIdOrThrow()`, while `/api/session`, Home, and Profile call `currentUserOrThrow()`. | Real session cookie / OAuth verification inside this module only. `/api/session` keeps returning `{ user }`; Home and Profile keep rendering the same identity shape; DB helper call sites keep their owner-id contract. |
| `lib/server/people-payload/index.server.ts` | Dispatches to mock by default, or DB when `KEEPSAKE_DATA_SOURCE=db`. | Later auth replaces `DEV_OWNER_ID`; route/page imports stay the same. |
| `lib/server/people-payload/mock.server.ts` | `getMockPeoplePayload()` reads `peoplePayload()` from `lib/mock.ts`. | Kept as fallback until all runtime paths are DB-backed. |
| `lib/server/people-payload/db.server.ts` | `getDbPeoplePayload()` resolves dev owner, opens transaction, calls `PeopleRepository.listWithRelations(ownerId)`. | Real auth replaces `auth/current-user.server.ts`; repository call remains. |
| `lib/server/delivery-history/index.server.ts` | Dispatches to mock by default, or DB when `KEEPSAKE_DATA_SOURCE=db`. | Later auth replaces `DEV_OWNER_ID`; `app/history/page.tsx` keeps calling only the server helper. |
| `lib/server/delivery-history/mock.server.ts` | `getMockDeliveryHistory()` reads `deliveries` from `lib/mock.ts`. | Kept as fallback until all runtime paths are DB-backed. |
| `lib/server/delivery-history/db.server.ts` | `getDbDeliveryHistory()` resolves dev owner, opens transaction, calls `DeliveryRepository.listByMonth(ownerId, { limit: 50 })`. | Same repo composition with real auth. History DB mode is read-only; enqueue/send/webhook/worker paths remain unimplemented. |
| `lib/server/draft-service/index.server.ts` | Dispatches draft generation, latest-draft restore, and version-history reads to mock by default, or DB when `KEEPSAKE_DATA_SOURCE=db`. | Later auth/LLM swaps stay behind this seam; route imports stay the same. |
| `lib/server/draft-service/mock.server.ts` | Validates/hydrates mock context and calls the mock generator. Does not write DB. Latest restore misses and version history returns an empty list. | Kept as fallback until all runtime paths are DB-backed. |
| `lib/server/draft-service/db.server.ts` | Resolves dev owner and opens one transaction. For POST it hydrates DB context, computes a prompt HMAC, checks `DraftRepository.findByPromptHash`, then saves misses via `DraftRepository.save`; for GET latest it validates the same person/occasion context and calls `DraftRepository.getLatestFor`; for versions it validates context, reads `DraftRepository.listForPerson`, filters to the resolved occasion, and slices the safe limit. | Same orchestration with real auth and a future LLM generator. |
| `lib/server/draft-context/index.server.ts` | Dispatches to mock by default, or DB when `KEEPSAKE_DATA_SOURCE=db`. | Later auth replaces `DEV_OWNER_ID`; route import stays the same. |
| `lib/server/draft-context/mock.server.ts` | `resolveMockDraftContext(input)` validates + finds person/relationship/culture/occasion in the mock store. | Kept as fallback until all runtime paths are DB-backed. |
| `lib/server/draft-context/db.server.ts` | `resolveDbDraftContext(input)` resolves the owner, opens a transaction, hydrates person/catalog/occasion via repos under RLS. Also exposes `resolveDbDraftContextInTx` so draft persistence can reuse the outer transaction. | Same repo composition with real auth. |
| `lib/server/draft-generator/mock.server.ts` | `createMockDraftGenerator().generate(ctx)` builds a `MessageDraft` from `baseRecipe` + `applyInstruction` — pure data-driven heuristics. | A real `DraftGenerator` implementation backed by an LLM client. Same `DraftGenerator` interface from `lib/server/draft-generator/types.ts`. |

The route handlers do not move.

---

## 5. Replacement plan

| Current module | Future replacement | What should NOT change | Tests guarding it |
|---|---|---|---|
| `lib/server/auth/current-user.server.ts` | Real auth-backed current user resolver | `currentUserIdOrThrow(): OwnerId`; `currentUserOrThrow()` returning `{ id, email, name, initials }`; typed unauthenticated vs misconfigured errors | `pnpm test:auth`, `pnpm test:home`, `pnpm test:profile`, `pnpm test:boundaries` |
| `app/api/session/route.ts` | Unchanged route contract over real auth | Thin shape: call auth service → return `{ user }`; 401 for missing auth; 500 for invalid server auth config; no DB/cookies/OAuth/Gmail writes in the route | `pnpm test:auth` |
| `lib/server/people-payload/index.server.ts` | Keep as dispatcher until mock can be deleted | `getPeoplePayload()` signature; `GET /api/people` returning `PeoplePayload` | `pnpm test:people`, `pnpm test:db:people-route` |
| `lib/server/people-payload/db.server.ts` | Real auth-backed owner resolution instead of `DEV_OWNER_ID` | Repository call and `PeoplePayload` shape | `pnpm test:db:people-route` |
| `lib/server/delivery-history/index.server.ts` | Keep as dispatcher until mock can be deleted | `getDeliveryHistory()` signature; History page receives `Delivery[]`; email/post remain badges rather than separate product modes | `pnpm test:history`, `pnpm test:db:history-route` |
| `lib/server/delivery-history/db.server.ts` | Real auth-backed owner resolution instead of `DEV_OWNER_ID` | Read-only `DeliveryRepository.listByMonth` call; no enqueue/send/webhook/worker behavior | `pnpm test:db:deliveries`, `pnpm test:db:history-route` |
| `lib/server/draft-service/index.server.ts` | Keep as dispatcher until mock can be deleted | `generateDraft(input)`, `getLatestDraft(input)`, and `listDraftVersions(input)` result shapes; routes stay parse/query → delegate → response | `pnpm test:drafts`, `pnpm test:db:drafts-route` |
| `lib/server/draft-service/db.server.ts` | Real auth-backed owner resolution and future LLM generator | One transaction for context resolution + cache lookup + save on POST, context resolution + latest read on GET, and context validation + version list read on `/api/drafts/versions`; prompt HMAC is based on resolved server-side context + instruction + generator id; generator remains mock today | `pnpm test:db:drafts-repository`, `pnpm test:db:drafts-route` |
| `lib/server/draft-context/index.server.ts` | Keep as dispatcher until mock can be deleted | `resolveDraftContext(input)` signature; `DraftContextResolution` shape (`ok:true ∣ ok:false+status+error`); `400 / 404 / 500` boundary | `pnpm test:drafts`, `pnpm test:db:drafts-route` |
| `lib/server/draft-context/db.server.ts` | Real auth-backed owner resolution instead of `DEV_OWNER_ID` | Repo composition only; context shape and error semantics stay stable | `pnpm test:db:drafts-route` |
| `lib/server/draft-generator/mock.server.ts` | LLM-backed implementation of `DraftGenerator` from `lib/server/draft-generator/types.ts` | `generate(ctx): Promise<MessageDraft>` signature; `DraftContext` input shape; `MessageDraft` output (paragraphs plain text, highlights array, attachedCard hints) | `pnpm test:drafts` (`tone = tender-intimate`, `tone = playful`, `tone = warm-festive`, no-Christmas, contains "Selamat Hari Raya") |
| `lib/mock.ts` | Postgres queries via repos; this file is deleted, not migrated | The mock data shape (everything matches `lib/domain.ts`); the catalog ids (`'rel-partner'`, `'chinese'`, etc.) match `db/seed_catalog.sql` | Both smoke tests (any drift surfaces as a contract failure) |
| `app/api/people/route.ts` | Unchanged | The 7-line shape: import server helper → return its result | `pnpm test:people` |
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
- **Don't add new "Add someone" / People-editing UI before the repo
  layer can persist it.** Adding it now means another set of mock writes
  that the DB migration will have to unwind.
