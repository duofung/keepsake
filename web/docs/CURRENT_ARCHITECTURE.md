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
  │                         │  lib/server/people-payload/mock.server.ts
  │                         │      │  getPeoplePayload()
  │                         │      ▼
  │                         │  lib/mock.ts
  │                         │      │  peoplePayload()
  │                         │      ▼
  │  ◄──── PeoplePayload ───┤  NextResponse.json({...})
  │                         │
```

Route is `force-static`: the mock-backed payload is static/cacheable until the
route is replaced by a user-scoped repository call.

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
  │                         │  lib/server/draft-context/mock.server.ts
  │                         │      │   resolveDraftContext(input)
  │                         │      │     · validate required fields
  │                         │      │     · findPerson / findRelationship / findCulture
  │                         │      │     · findOccasion + cross-person check
  │                         │      │   → { ok:true, ctx } | { ok:false, status, error }
  │                         │      │
  │                         │      ▼ (if ok)
  │                         │  lib/server/draft-generator/mock.server.ts
  │                         │      │   draftGenerator.generate(ctx)
  │                         │      │     · baseRecipe(ctx)
  │                         │      │     · applyInstruction(recipe, ctx)
  │                         │      │     · assemble MessageDraft
  │                         │      ▼
  │  ◄──── MessageDraft ────┤  NextResponse.json(draft)
  │                         │
```

Route is `force-dynamic`. No DB call today; the `mock.server.ts` files are
the seams that will become repository calls.

---

## 2. Layer responsibilities

| Layer | Path | Job today | Touches HTTP? | Touches DB? | Touches LLM? |
|---|---|---|---|---|---|
| Pages | `app/page.tsx`, `app/people/`, `app/workspace/`, `app/history/`, `app/profile/` | Render. Home, People, and History read async server helpers; Workspace fetches `/api/people` and `/api/drafts` at runtime; Profile is static settings UI. | yes (client fetch) | no | no |
| API routes | `app/api/people/route.ts`, `app/api/drafts/route.ts` | Parse JSON, return JSON, set status. Delegate everything else. | yes | no | no |
| Server services | `lib/server/people-payload/mock.server.ts`, `lib/server/delivery-history/mock.server.ts`, `lib/server/draft-context/mock.server.ts`, `lib/server/draft-generator/mock.server.ts` | The mock seams. Each starts with `import "server-only"`. | no | no (mock) | no (mock) |
| Mock store | `lib/mock.ts` | In-memory data: 5 people, 7 occasions, 4 cultures, 5 relationships, 4 deliveries + finder helpers. | no | no | no |
| Domain | `lib/domain.ts` | Canonical TypeScript types — the contract between layers and over the wire. No HTML in message content. Card/icon hints are explicit structured fields, not rendered markup. | no | no | no |
| Presentation | `lib/presentation.ts` | Maps `OccasionKind`/`Tone`/`Channel` → icon names, gradients, chip text. UI only. | no | no | no |
| Repository interfaces | `lib/repositories/{catalog,people,drafts,deliveries,types,index}.ts` | Type-only signatures. No implementations exist yet. | no | no | no |
| DB scripts | `db/schema.sql`, `db/seed_catalog.sql`, `db/README.md` | Postgres 17 schema + seed (10 relationships, 4 cultures). Verified once against `postgres:17-alpine`. Not wired to runtime. | no | n/a (sketch) | no |
| Smoke tests | `scripts/test-people.mjs`, `scripts/test-drafts.mjs` | Boot `next dev` on an isolated port, run HTTP assertions, kill the server. `pnpm test` runs both. | yes (HTTP) | no | no |

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
3. **`POST /api/drafts` request shape** = `{ personId, occasionId, userInstruction }`,
   nothing else. Anything that smells like "let the client name a
   relationship / culture / tone override" violates the server-authoritative
   contract and must be rejected at the route. Covered by `pnpm test:drafts`.
4. **`POST /api/drafts` response shape** = `MessageDraft`. Same coverage.
5. **Culture rules resolve server-side only.** The client never sends a
   `CultureRule`; the server reads it from the person's `culture_id`.
   Implementation in `lib/server/draft-context/mock.server.ts`.
6. **`MessageDraft.paragraphs[].text` is plain text.** Highlights live in
   `paragraphs[].highlights: string[]`, applied by the client renderer
   (see [`app/workspace/page.tsx`](../app/workspace/page.tsx) — the
   `renderParagraph` helper). No `<span>`, no HTML strings, ever.
7. **Server-only modules must begin with `import "server-only"`.** Filename
   convention is `*.server.ts`. See
   [`lib/server/README.md`](../lib/server/README.md) and
   [`lib/repositories/README.md`](../lib/repositories/README.md#implementation-file-naming).

---

## 4. Mock seams (what swaps when we wire the DB / LLM)

Four files. They're the only ones that move when the back end goes real.

| Seam | What it does today | What replaces it |
|---|---|---|
| `lib/server/people-payload/mock.server.ts` | `getPeoplePayload()` reads `peoplePayload()` from `lib/mock.ts`. | `PeopleRepository.listWithRelations(ownerId)` — one batched query under RLS. |
| `lib/server/delivery-history/mock.server.ts` | `getDeliveryHistory()` reads `deliveries` from `lib/mock.ts`. | `DeliveryRepository.listHistory(ownerId)` — reverse-chronological sent history under RLS. |
| `lib/server/draft-context/mock.server.ts` | `resolveDraftContext(input)` validates + finds person/relationship/culture/occasion in the mock store. | Composition of `PeopleRepository.findById` + `CatalogRepository.getRelationship/getCulture` + `PeopleRepository.findOccasionForPerson`, all inside a `db/transaction.server.ts` with `SET LOCAL app.user_id`. |
| `lib/server/draft-generator/mock.server.ts` | `createMockDraftGenerator().generate(ctx)` builds a `MessageDraft` from `baseRecipe` + `applyInstruction` — pure data-driven heuristics. | A real `DraftGenerator` implementation backed by an LLM client. Same `DraftGenerator` interface from `lib/server/draft-generator/types.ts`. |

The route handlers do not move.

---

## 5. Replacement plan

| Current module | Future replacement | What should NOT change | Tests guarding it |
|---|---|---|---|
| `lib/server/people-payload/mock.server.ts` | `PeopleRepository.listWithRelations(ownerId)` impl, called from the same helper file (renamed to e.g. `people-payload/db.server.ts`) | `getPeoplePayload()` signature; `GET /api/people` returning a `PeoplePayload`; static route classification at build | `pnpm test:people` (15 assertions on shape + cultural wiring) |
| `lib/server/delivery-history/mock.server.ts` | `DeliveryRepository.listHistory(ownerId)` impl, called from the same helper file (renamed to e.g. `delivery-history/db.server.ts`) | `getDeliveryHistory()` signature; History page receives `Delivery[]`; email/post remain badges rather than separate product modes | TODO: add `scripts/test-history.mjs` or page-level smoke |
| `lib/server/draft-context/mock.server.ts` | Repository-backed resolver under RLS; same discriminated union return | `resolveDraftContext(input)` signature; `DraftContextResolution` shape (`ok:true ∣ ok:false+status+error`); `400 / 404 / 500` boundary | `pnpm test:drafts` (`missing fields → 400`, `unknown person → 404` indirectly via `Lin initial → 200`, `cross-person occasion → 404`) |
| `lib/server/draft-generator/mock.server.ts` | LLM-backed implementation of `DraftGenerator` from `lib/server/draft-generator/types.ts` | `generate(ctx): Promise<MessageDraft>` signature; `DraftContext` input shape; `MessageDraft` output (paragraphs plain text, highlights array, attachedCard hints) | `pnpm test:drafts` (`tone = tender-intimate`, `tone = playful`, `tone = warm-festive`, no-Christmas, contains "Selamat Hari Raya") |
| `lib/mock.ts` | Postgres queries via repos; this file is deleted, not migrated | The mock data shape (everything matches `lib/domain.ts`); the catalog ids (`'rel-partner'`, `'chinese'`, etc.) match `db/seed_catalog.sql` | Both smoke tests (any drift surfaces as a contract failure) |
| `app/api/people/route.ts` | Unchanged | The 7-line shape: import server helper → return its result | `pnpm test:people` |
| `app/api/drafts/route.ts` | Unchanged | Three-step shape: parse JSON → resolve → generate | `pnpm test:drafts` |
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
- **Don't add new "Add someone" / People-editing UI before the repo
  layer can persist it.** Adding it now means another set of mock writes
  that the DB migration will have to unwind.
