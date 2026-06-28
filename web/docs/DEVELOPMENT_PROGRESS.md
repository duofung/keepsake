# Keepsake / ReMaster Development Progress

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
| App shell + core UI | MVP demo-ready desktop | Full-screen desktop shell, Home, People, Workspace, History, Profile, preview-safe icon fallback, page smoke tests, and an end-to-end `pnpm test:mvp-demo` flow. | Mobile pass, deeper visual polish, interaction polish. |
| ReMaster pivot / model blueprint | Compatibility runtime + business contact foundation + outreach workspace + touchpoint layer + dossier + maintenance loop + active/archive management | `README.md`, `CURRENT_ARCHITECTURE.md`, and `REMASTER_MODEL.md` define the business-first target model. `lib/remaster/read-model.ts` and `lib/server/remaster-overview/index.server.ts` derive `Account` / `Contact` / `Activity` read models from the current `PeoplePayload` + `Delivery[]`, now including touchpoint labels for last touch, next follow-up, and recent outreach. People has native business contact fields (`segment`, `organization`, `roleTitle`, `sourceContext`), update/archive/restore maintenance routes, active/archived management, business segment tabs, and a relationship dossier drawer that can edit active contacts inline and restore archived contacts; Workspace frames drafts as segment-aware business outreach with lightweight presets, and Home / People / History now read as a follow-up dashboard, relationship list, and touchpoint timeline. Profile + Sign-in and command-channel replies remain ReMaster-framed while keeping the current auth, Gmail, channel, worker, webhook, draft, and send contracts. | Plan native account/activity schema, backfill, and route deprecation later. |
| Domain model | Stable current runtime with contact segments and maintenance dates | `domain.ts`, presentation mapping, mock data, API contracts. `Person` remains the storage/API anchor but now carries business contact fields for client/partner/prospect/investor/personal classification plus lightweight `lastContactAt`, `nextFollowUpAt`, and `archivedAt` maintenance fields. | Native account/contact split, stakeholder roles, imports, merge semantics. |
| Mock seams | Stable | People payload, draft context, draft service, delivery history dispatchers default to mock. | Delete mock fallback only after DB mode is default and production-ready. |
| DB schema/RLS | Stable | Postgres schema, catalog seed, local dev fixtures, RLS, transaction helper. | Future migrations for real auth/session, reminders, send queue details. |
| Crypto | Stable | AES-256-GCM envelope helper, AAD conventions, tests. | KMS/DEK wrapping hardening for production. |
| People data | Stable read/create/update/archive/restore path, business-first surface | DB-backed people payload, repository reads, `PeopleRepository.create/update/archive/restore`, `POST /api/people`, `PATCH /api/people/[id]`, `POST /api/people/[id]/archive`, `POST /api/people/[id]/restore`, and People-page Add contact + drawer maintenance flow now round-trip `segment`, `organization`, `roleTitle`, `sourceContext`, remember notes, `lastContactAt`, and `nextFollowUpAt` in mock and DB modes. The People page groups by Clients / Partners / Prospects / Investors / Personal, defaults to Active contacts, can switch to Archived contacts, and opens a business-first relationship dossier drawer with overview, inline maintenance for active contacts, review-only archived state, restore, context, touchpoints, notes, and workspace actions while mock mode still returns a `local-*` person for browser-local preview continuity. | Imports, merge semantics, richer follow-up scheduling, native account/activity schema/backfill. |
| Draft generation/persistence | Stable mock + opt-in LLM seam + DB persistence + user-edit versioning | DB-backed draft context/service, draft repository, latest/version reads. `KEEPSAKE_DRAFT_SOURCE=openai` plugs an OpenAI-compatible provider in behind `getDraftGenerator()`; default stays mock. `PATCH /api/drafts` persists Workspace subject + body + card edits as new canonical versions with `prompt_input_hash = NULL`. Workspace outreach presets are page-layer framing and fold into the existing `userInstruction` string only when the user asks for a revision; no new draft fields or route contract. | Tone editing, prompt evaluation harness, A/B, retries on `unavailable`, prompt provenance beyond `model_provider` / `model_version`. |
| Delivery history | Stable read path + touchpoint timeline framing | DB-backed delivery-history read repository, History relationship/touchpoint timeline framing, and status badges for delivered/opened/failed rows. The underlying delivery storage, webhook, worker, and send contracts are unchanged. | Pagination, filters, live status refresh, native ReMaster activity storage. |
| Auth/current user | Cookie-backed session foundation + Google sign-in transport + `/signin` page + page-level redirects + sign-out + dev fallback | `keepsake_session` HMAC-signed cookie is the primary identity source. Product pages call `requireSessionUserOrRedirect()` (cookie-only, redirects unauth to `/signin?returnTo=…`). Routes / API handlers / server seams still use `currentUserOrThrow()` (cookie-first with `DEV_OWNER_*` env fallback). `/api/auth/google/{start,callback}` runs the real Google identity flow. `/api/auth/dev-session/{start,clear}` are gated dev bootstrap; start 303s when given `?returnTo=`. `POST /api/auth/signout` clears the cookie and 303s to `/signin` — no DB, no Google revoke, no Gmail disconnect. Profile's "Sign out" row is now a real form POST. `/api/session` shape unchanged. | Retiring the `DEV_OWNER_*` env fallback from the cookie-first seam; Google grant revoke on signout. |
| Gmail OAuth | Stable start + callback | Full HMAC state cookie, native-fetch token exchange, account upsert on success, cookie cleared on every response. | Token refresh + markExpired on send failure, Google revoke on disconnect. |
| Sending account UI | Connect/Disconnect wired | ReMaster-framed Profile shows Not connected / Connected / Expired with Connect / Reconnect / Disconnect CTAs that drive `/api/oauth/gmail/start` and `POST /api/gmail/disconnect`. Idempotent + cross-owner safe. | Auto-repair on expired refresh, Google revoke on disconnect, multi-account support. |
| Email send | Stable end-to-end (enqueue + bounded loop runtime + Gmail send + stale-recovery + webhook status ingest + History surfaces status + runbook documents manual lifecycle and troubleshooting) | `POST /api/deliveries` queues a row with `recipientEmail` encrypted; `pnpm worker:run` drives `runWorkerLoop({ maxTicks, recovery, stopOnFailure })`, which optionally requeues stuck `'sending'` rows then drains the queue one tick at a time via `processNextQueuedEmail()`. SELECT FOR UPDATE SKIP LOCKED + `sending` state prevents double-send in healthy operation; stale recovery is operator-gated with explicit duplicate-send risk. `POST /api/webhooks/deliveries` accepts provider-agnostic delivered/opened/failed events behind a shared-secret gate and advances `deliveries.status` monotonically (no downgrade). `/history` reads the row's current status and surfaces it as one of three tone families (neutral / success / warn) — failed bounces render as a red alert badge instead of borrowing the delivered green. `docs/DELIVERY_RUNBOOK.md` walks an operator through the full Workspace→worker→webhook→History loop with grouped env vars and per-step troubleshooting. | Real Gmail push subscription, retry/backoff queue, cron/daemon, concurrent worker pool, post-channel worker, `Person.email` / `person_contacts` model, live status updates (polling / SSE). |
| Command Channel Platform | Foundation + identity-link schema + repository runtime + DB-backed mock inbound + owner-scoped read path + Profile mock/Telegram/WhatsApp link/revoke UI + review URLs + Telegram adapter/start-link binding + WhatsApp inbound foundation (P8-A → P11-B), now ReMaster-framed | P8-A: provider-agnostic `CommandEvent` / `CommandIntent` / `CommandResponse` contract + deterministic keyword router + `POST /api/channels/mock`. Channel layer never sends mail, never enqueues, never creates a draft. P8-B: `channel_accounts` schema + RLS policy + `ChannelAccountRepository` interface design. P8-C: `PgChannelAccountRepository` Postgres runtime — `findByProviderUser` (worker tx required, no fallback), `listForOwner`, `link`, `markRevoked`; `display_name_enc` encrypted with AAD `owner_id ‖ channel_accounts ‖ display_name_enc`. P8-D: `POST /api/channels/mock/inbound` runs DB-only mock provider identity resolution (`externalUserId → owner_id`) through a worker transaction, returns `needs_link` for missing/revoked links, and only then calls the shared router. P8-E: `handleOwnerCommand(ownerId, event)` opens `transaction(ownerId, …)` and enriches a follow-up reply with that owner's real people + upcoming occasions (≤30 days, top 3 by daysUntil). P8-F: Profile gains a "Command channels" section with `POST /api/channels/mock/{link,revoke}` form actions; DB mode shows real linked rows + a link form, mock mode shows a DB-mode-required placeholder. P8-G: `CommandResponse.reviewUrl` gives adapters a relative ReMaster review link (`/people`, `/workspace?...`, `/profile#command-channels`) while preserving the no-execution invariant. P8-H: `POST /api/channels/telegram` verifies Telegram's webhook secret, normalises private text messages, resolves Telegram user ids through `channel_accounts`, and replies through Telegram Bot API with ReMaster review-pointer copy. P8-I: Profile DB mode can manually link/revoke Telegram user ids. P8-J: Profile renders a signed `https://t.me/<bot>?start=<token>` link; Telegram `/start <token>` verifies the stateless token and links that Telegram user to the owner. P10-F reframes mock, DB-backed inbound, and Telegram replies as account/contact outreach review without changing `CommandIntent`, `SuggestedAction`, `reviewUrl`, route, schema, draft/send, worker, webhook, or Gmail contracts. P11-A adds a DB-only WhatsApp text webhook that verifies a shared secret, resolves `provider="whatsapp"` through `channel_accounts`, and returns the same review-first JSON response. P11-B adds Profile `wa.me` link-token generation, WhatsApp token consumption, cross-owner conflict handling, and `/api/channels/whatsapp/revoke`. Still no WhatsApp outbound send/templates/media, no Slack adapter, no draft creation, no enqueue, no Gmail send. | Slack adapter, WhatsApp outbound/template-aware replies, dedupe/persistence of provider update ids, one-time nonce table if needed, notification + reminder outbound, LLM intent classifier behind the same router seam. |
| Reminders/scheduler | Not started | Occasion data exists. | Reminder jobs, notification strategy, due-date windows. |
| MVP demo / release readiness | Close-out in progress | `docs/MVP_DEMO_RUNBOOK.md`, `pnpm test:mvp-demo`, `pnpm test`, `pnpm build`, and `git diff --check` define the close-out gate. P9 adds the last product-critical create path found during user testing. | Final verification and deployment checklist. |
| Deployment/ops | Local only | Local env guard/init, Docker DB tests, delivery lifecycle runbook, and MVP demo runbook. | Production env, CI, hosting, logs, secrets, migrations. |

## ReMaster Pivot Snapshot

This pivot is partially implemented through a compatibility runtime. The
current storage schema and route contracts are still the legacy
relationship-first model.

| Area | Current runtime | Planned ReMaster direction |
|---|---|---|
| Primary anchor | `Person` + upcoming `OccasionNode` | `Account` + `Contact` + `ActivityEvent` |
| Relationship taxonomy | Business `segment` on `Person` plus legacy relationship catalog for compatibility | Business relationship type on a future account, stakeholder role on the contact/account link |
| Timeline/history | `Delivery` history plus occasion-derived follow-up prompts | Unified account/contact activity timeline, with delivery as one event family |
| Product surfaces | Home + People + Workspace + History through compatibility account/contact/activity views; Profile + Sign-in and command-channel replies compatibility-framed on top of the current auth/Gmail/channel runtime | Account list/detail, contact/stakeholder views, activity timeline, outreach workflow |

Reference:

- [`REMASTER_MODEL.md`](./REMASTER_MODEL.md) is the forward-looking model
  blueprint.
- [`CURRENT_ARCHITECTURE.md`](./CURRENT_ARCHITECTURE.md) still describes the
  live code and request flows.
- The first runtime slices have shipped: Home, People, Workspace, and History now render
  compatibility `Account` / `Contact` / `Activity` views derived from the
  current person-centered storage model. The read model now carries lightweight
  touchpoint labels (`lastTouchLabel`, `nextFollowUpLabel`,
  `touchpointSummary`) so these pages can show relationship cadence without a
  native account/activity schema. Profile and Sign-in have matching ReMaster
  framing, and command-channel replies now use ReMaster review-pointer
  language, but their auth, Gmail, channel, worker, webhook, and send contracts
  remain unchanged.

### P12-F. Archived / Active Contact Management

Status: implemented. Guarded by `pnpm test:people`, `pnpm test`,
`pnpm test:db`, `pnpm build`, and `git diff --check`.

Goal: complete the contact maintenance loop by letting users manage active
and archived contacts, restore archived rows, and keep archived contacts out
of default follow-up surfaces without changing drafts, deliveries, worker,
webhook, Gmail, Telegram, WhatsApp, payment, or subscription contracts.

Shipped:

- `PeopleRepository` now supports active/archived scoped reads via the
  existing list methods and adds owner-scoped `restore(ownerId, personId,
  tx?)`. Default reads remain active-only; archived reads are opt-in.
- `/api/people` accepts a lightweight `?view=archived` filter for archived
  management while keeping the default `PeoplePayload` shape active-only.
  New thin route `POST /api/people/[id]/restore` delegates through the
  existing `people-maintenance` seam and returns `{ person }`.
- People now has an Active / Archived toggle. Active remains the default;
  archived contacts are fetched on demand, shown with archived status, and can
  be restored without opening a new page.
- The dossier drawer shows a clear archived state, keeps archived contacts
  review-only, switches the action area from Archive to Restore, and restores
  contacts back into Active People/Home/workspace eligibility.
- The ReMaster read model now excludes deliveries tied to non-active people
  from default dashboard recent-outreach cards. History still renders all
  delivery rows as touchpoint history.
- No DB schema migration was needed; P12-E's existing `archived_at` column is
  the restore source of truth.

Out of scope:

- No native account schema, import/merge flow, pipeline/deal management,
  mobile pass, payment/subscription work, new dashboard page, or
  drafts/deliveries/worker/webhook/Gmail/WhatsApp/Telegram semantic change.

### P12-E. Business Contact Maintenance Loop

Status: done. Guarded by `pnpm test:people`, `pnpm test:db:people`,
`pnpm test:db:people-route`, `pnpm test`, `pnpm test:db`,
`pnpm build`, and `git diff --check`.

Goal: make business contacts sustainable after creation by adding inline
maintenance for profile fields, remember notes, last touch, next follow-up,
and soft archive, without introducing a native account schema or changing
drafts, deliveries, worker, webhook, Gmail, Telegram, or WhatsApp contracts.

Shipped:

- `Person` now carries `nextFollowUpAt` and `archivedAt` alongside the
  existing business contact fields and `lastContactAt`; `people` has matching
  nullable `next_follow_up_at` and `archived_at` columns.
- `PeopleRepository` supports owner-scoped `update(ownerId, personId, patch,
  tx?)` and `archive(ownerId, personId, tx?)` under the existing transaction
  seam. Default people reads and occasion reads filter `archived_at IS NULL`;
  delivery history keeps using denormalized delivery rows and remains visible.
- New thin routes `PATCH /api/people/[id]` and
  `POST /api/people/[id]/archive` parse/validate/delegate through the
  `people-maintenance` server seam. Mock and DB mode both return the updated
  `Person` shape; invalid bodies return 400 and missing/cross-owner rows return
  404.
- The People relationship dossier drawer now has a maintenance loop section
  for name, segment, organization, role/title, source context, remember note,
  last touch, and next follow-up, plus an archive action. Archiving removes the
  contact from People/Home active reads but does not delete history rows.
- People and Home copy naturally reflect updated last-touch / next-follow-up
  data through the existing ReMaster read model, which now prefers
  `Person.nextFollowUpAt` when present.

Out of scope:

- No native account table, import/merge flow, deal pipeline, payment or
  subscription work, drafts/deliveries route contract change, worker/webhook
  change, Gmail OAuth change, Telegram/WhatsApp route change, or mobile pass.

### P12-D. People Detail Dossier

Status: done. Guarded by `pnpm test:people`, `pnpm test`,
`pnpm build`, and `git diff --check`.

Goal: upgrade the People drawer from a static contact detail panel into a
business-first relationship dossier while preserving the existing People list,
Add contact flow, and `/workspace?person=...` bridge.

Shipped:

- `PeopleClient` now passes the selected compatibility account into
  `PersonDrawer`, so the drawer can reuse the existing `lastTouchLabel`,
  `nextFollowUpLabel`, and `touchpointSummary` derived in the ReMaster
  read-model.
- `PersonDrawer` now renders a relationship dossier structure: overview,
  relationship context, touchpoints, notes / remember, and actions. Business
  fields (`segment`, `organization`, `roleTitle`, `sourceContext`) are primary,
  while personal contacts and missing business fields use natural fallbacks.
- Drawer actions stay on the existing `/workspace?person=...` route. No edit
  route, pipeline, account entity, draft field, delivery change, or send action
  was introduced.
- `scripts/test-people.mjs` pins the dossier shell and section anchors while
  keeping the existing People page and `/api/people` smoke coverage.

Out of scope:

- No DB schema change, route contract change, account table, CRM pipeline,
  deal/stage tracking, provider integration, payment/subscription, draft/send
  semantic change, worker/webhook/Gmail OAuth change, or Telegram/WhatsApp
  route change.

### P12-C. Business Timeline / Touchpoint Layer

Status: done. Guarded by `pnpm test:home`, `pnpm test:people`,
`pnpm test:history`, `pnpm test`, `pnpm build`, and `git diff --check`.

Goal: make ReMaster feel like an ongoing relationship follow-up and
touchpoint tracker instead of a static contact list plus composer.

Shipped:

- `lib/remaster/read-model.ts` now derives lightweight touchpoint fields for
  accounts and activities: last touch, next follow-up, and touchpoint summary.
  These are computed from existing people, occasions, deliveries, and optional
  last-contact dates.
- Home now frames the dashboard around upcoming milestones, recent outreach,
  and contacts needing follow-up. Account cards show next follow-up, last
  touch, and business context.
- People cards now surface next follow-up, last touch, and business context
  more explicitly while preserving the existing drawer, Add contact flow, and
  `/workspace?person=...` bridge.
- History now reads as a relationship touchpoint timeline. Existing delivery
  rows and delivery status badges remain the source of truth; no synthetic
  touchpoints are created.

Out of scope:

- No DB schema change, route contract change, account table, CRM pipeline,
  deal/stage tracking, provider integration, payment/subscription, draft/send
  semantic change, worker/webhook/Gmail OAuth change, or Telegram/WhatsApp
  route change.

### P12-B. Business Outreach Workspace

Status: done. Guarded by `pnpm test:workspace`, `pnpm test`,
`pnpm build`, and `git diff --check`.

Goal: move Workspace from a personal message composer toward ReMaster's
business-first outreach workspace while preserving personal notes and the
existing draft, autosave, inline edit, delivery queue, worker, webhook, Gmail,
Telegram, and WhatsApp contracts.

Shipped:

- `/workspace` now derives segment-aware page framing from the current contact:
  client follow-up, partner outreach, prospect outreach, investor update, or
  personal note.
- The header, activity chip, assistant helper card, compose draft label,
  placeholder, and footer copy are business-first and still show honest
  fallbacks when organization, role/title, or source context is missing.
- Workspace adds lightweight intent presets: Follow up, Recap, Check-in,
  Congratulations, Intro, and Personal. They coexist with the existing tone
  controls and change helper copy plus preset-specific quick actions.
- Presets do not introduce backend fields. When the user asks for a revision,
  the selected preset is folded into the existing `userInstruction` string sent
  to `POST /api/drafts`; autosave still uses `PATCH /api/drafts`, and queueing
  still uses `POST /api/deliveries` after flushing edits.

Out of scope:

- No DB schema change, account table, CRM pipeline, provider integration,
  payment/subscription, worker/webhook/Gmail OAuth change, Telegram/WhatsApp
  route change, or draft/delivery contract migration.

### P12-A. Business Contact Foundation

Status: done. Guarded by `pnpm test:people`, `pnpm test:db:people`,
`pnpm test:db:people-route`, `pnpm test`, `pnpm test:db`,
`pnpm build`, and `git diff --check`.

Goal: move People and Add contact from personal-relationship-first toward
ReMaster's business contact model while preserving personal contacts and the
existing draft, delivery, worker, webhook, Gmail, WhatsApp, and Telegram paths.

Shipped:

- `Person` now carries `segment: client | partner | prospect | investor |
  personal`, plus encrypted DB-backed `organization`, `roleTitle`, and
  `sourceContext` fields. DB rows default `segment` to `personal`, so legacy
  rows and existing insert paths keep working.
- `PeopleRepository` reads and creates the new fields under the existing
  owner-scoped transaction/RLS seam. Mock fixtures and encrypted dev fixture
  seeding carry business examples for client, partner, prospect, investor, and
  personal contacts.
- `POST /api/people` accepts the business Add contact payload, still maps
  legacy relationship/culture defaults internally, and returns the same `Person`
  JSON shape extended with the new fields.
- `/people` now uses business tabs (`All`, `Clients`, `Partners`, `Prospects`,
  `Investors`, `Personal`), business-first title/copy, and cards that prioritize
  name, organization / role title, then next activity, last outreach, or
  relationship context.
- The existing drawer, Workspace deep link (`/workspace?person=...`), command
  flow, drafts, deliveries, worker, webhook, Gmail, WhatsApp, and Telegram
  route contracts were not changed.

Out of scope:

- No account table, CRM pipeline, deals, payment/subscription, provider
  integration, delivery/draft contract migration, or large refactor.

### P11-B. WhatsApp Link / Revoke Flow

Status: done. Guarded by `pnpm test:profile`,
`pnpm test:db:channel-profile`, `pnpm test:db`, `pnpm test`, and
`pnpm build`.

Goal: make WhatsApp a bindable and revocable command channel beside mock and
Telegram without changing the command router, drafts, deliveries, worker,
webhook, Gmail, schema, or outbound messaging contracts.

Shipped:

- Profile's Command Channels section now renders a WhatsApp `wa.me` link CTA
  in DB mode when `WHATSAPP_LINK_PHONE_NUMBER` and
  `APP_SESSION_SIGNING_SECRET` are configured.
- `lib/server/channels/whatsapp-link-token.server.ts` issues a stateless
  15-minute HMAC-signed ReMaster link token and verifies WhatsApp token
  messages before linking `(provider="whatsapp", message.from)`.
- `lib/server/channels/whatsapp.server.ts` consumes link-token messages before
  normal owner-command routing, maps cross-owner conflicts to `already_linked`,
  and still returns review-first JSON without echoing internal `ownerId`.
- `app/api/channels/whatsapp/revoke/route.ts` lets Profile revoke linked
  WhatsApp rows through the shared channel-account metadata seam.
- `scripts/test-channel-accounts-profile-db-route.mjs` covers link CTA
  presence, token generation/use, already-linked conflict, revoke,
  linked/unlinked Profile rendering, and no-session revoke protection.

Out of scope:

- No WhatsApp outbound send/reply, campaign, template handling,
  media/attachment handling, draft creation, delivery enqueue, Gmail call,
  command intent change, worker change, or schema change.

### P11-A. WhatsApp Inbound Webhook Foundation

Status: done. Guarded by `pnpm test:db:channels-whatsapp`,
`pnpm test:db`, `pnpm test`, and `pnpm build`.

Goal: add a DB-backed WhatsApp inbound provider adapter that reuses the
existing command-channel foundation without changing drafts, deliveries,
worker, webhook, Gmail, schema, UI, or route contracts elsewhere.

Shipped:

- `app/api/channels/whatsapp/route.ts` is a thin POST route that parses JSON
  and delegates to the server-only WhatsApp seam.
- `lib/server/channels/whatsapp.server.ts` verifies
  `WHATSAPP_WEBHOOK_SECRET` via `x-whatsapp-webhook-secret`, requires
  `KEEPSAKE_DATA_SOURCE=db`, normalises WhatsApp Cloud API text messages into
  `CommandEvent`, and resolves `(provider="whatsapp", externalUserId)` through
  `ChannelAccountRepository.findByProviderUser()` inside a worker transaction.
- Missing or revoked WhatsApp links return `needs_link` with
  `reviewUrl: "/profile#command-channels"`; active links delegate to
  `handleOwnerCommand(ownerId, event)` and return the same ReMaster
  review-first response used by mock/Telegram paths.
- `scripts/test-channels-whatsapp-db-route.mjs` covers missing/wrong secret,
  malformed JSON, ignored non-text payloads, unlinked, active follow-up,
  active compose, revoked, review URL presence, no internal `ownerId` echo, and
  no sent/delivered/queued execution claim.
- `package.json` adds `test:db:channels-whatsapp` and includes it in
  `pnpm test:db`.

Out of scope:

- No WhatsApp outbound send/reply, template handling, media/attachment
  handling, webhook verification challenge, provider message-id dedupe table,
  draft creation, delivery enqueue, Gmail call, worker change, or schema change.

### P10-F. Command Channels ReMaster Framing

Status: done. Guarded by `pnpm test:channels`,
`pnpm test:db:channels-inbound`, `pnpm test:db:channels-telegram`,
`pnpm test:mvp-demo`, `pnpm test`, and `pnpm build`.

Goal: align command-channel replies and helper copy with ReMaster's
account/contact outreach language without changing intent rules, route
contracts, DB schema, review URL shape, worker, webhook, delivery, draft, Gmail,
or channel-account runtime behavior.

Shipped:

- `routeCommandEvent()` still classifies the same
  `relationship_followup_query`, `compose_request`, and `unknown` intents, but
  replies now point users to ReMaster for account/contact follow-ups and
  outreach drafting.
- `handleOwnerCommand(ownerId, event)` still performs the same owner-scoped,
  read-only top-3/30-day follow-up enrichment, but renders it as outreach review
  and points back to ReMaster web for review, draft, and send.
- Mock inbound, Telegram inbound, and Telegram `/start <token>` link/recovery
  replies now use ReMaster wording and still return review pointers only. They
  never claim a send, delivery, queue action, or draft creation.
- Channel smokes now pin ReMaster copy, assert the replies no longer mention
  Keepsake, and keep the no-execution assertions.

Out of scope:

- No change to `CommandIntent`, `SuggestedAction`, `CommandResponse.reviewUrl`,
  route status codes, JSON contract, schema, worker, webhook, Gmail, deliveries,
  drafts, or command router intent rules.

### P10-E. Profile + Sign-in ReMaster Framing

Status: done. Guarded by `pnpm test:profile`, `pnpm test:signin`,
`pnpm test:mvp-demo`, `pnpm test`, and `pnpm build`.

Goal: align the remaining user-visible entry points with ReMaster's
account/contact outreach language without changing auth, Gmail OAuth, command
channels, DB schema, worker, webhook, or send contracts.

Shipped:

- `app/profile/page.tsx` keeps the same server auth guard, Gmail connect /
  disconnect controls, sign-out form, and command-channel forms, but reframes
  visible sections as workspace identity, outreach delivery, outreach workflow,
  plan/privacy, and inbound command channels.
- `app/signin/page.tsx` keeps the same Google identity CTA, dev-session gate,
  returnTo validation, and redirects, but explains that Google is the identity
  entry point for a ReMaster account/contact outreach workspace and that Gmail
  sender setup happens later from Profile.
- Profile, Sign-in, and the MVP demo smokes now pin the new ReMaster-facing copy
  while preserving the existing route and form contracts.

Out of scope:

- No DB schema change or migration.
- No auth, Google sign-in, Gmail OAuth, command-channel, send, worker, or
  webhook contract change.
- No UI redesign.

### P10-D. History ReMaster Compatibility View

Status: done. Guarded by `pnpm test:history`, `pnpm test:mvp-demo`,
`pnpm test`, and `pnpm build`.

Goal: migrate History from a pure delivery timeline to the first ReMaster
account/contact activity timeline without changing delivery storage, webhook,
worker, or send contracts.

Shipped:

- History now enters through `getRemasterHistoryCompatibilityView()` in
  `lib/server/remaster-overview/index.server.ts`, which composes the same
  derived account/contact/activity overview with the existing `Delivery[]`
  read path.
- `app/history/page.tsx` still renders current delivery rows and status badges,
  but frames rows as account/contact outreach activities with account name,
  primary contact, activity label, channel, date, and compatibility context.
- Archived delivery rows whose `personId` no longer maps to a current account
  keep their denormalized recipient name and render as archived contact
  activities.
- Delivered/opened/failed status labels, tone classes, and
  `data-delivery-status` attributes are unchanged.

Out of scope:

- No DB schema change or migration.
- No route/API contract change.
- No worker, webhook, Gmail OAuth, send-boundary, or command-router change.
- No UI redesign.

### P10-C. Workspace ReMaster Compatibility View

Status: done. Guarded by `pnpm test:workspace`, `pnpm test:mvp-demo`,
`pnpm test`, and `pnpm build`.

Goal: migrate Workspace framing to a ReMaster account outreach workspace while
leaving draft, autosave, delivery queue, worker, webhook, and Gmail contracts
unchanged.

Shipped:

- Workspace now enters through `getRemasterWorkspaceCompatibilityView()` in
  `lib/server/remaster-overview/index.server.ts`, reusing the compatibility
  overview and carrying the legacy payload only for the existing draft context.
- `app/workspace/WorkspaceClient.tsx` still routes by
  `/workspace?person=<primaryContactId>` but derives the account, contact, and
  current activity from the compatibility overview for the page header and
  context chip.
- Header/copy now frames the surface as account outreach, showing account name,
  primary contact, relationship/account type, context, next activity, or last
  delivery status.
- Draft restore/generate/version reads, autosave, and queue buttons still call
  `/api/drafts`, `/api/drafts/versions`, `PATCH /api/drafts`, and
  `/api/deliveries` with the existing person/occasion identifiers.

Out of scope:

- No DB schema change or migration.
- No route/API contract change.
- No worker, webhook, Gmail OAuth, or command-router intent-rule change.

### P10-B. People ReMaster Compatibility View

Status: done. Guarded by `pnpm test:people`, `pnpm test`, and `pnpm build`.

Goal: migrate People from the legacy relationship-directory framing to the
first ReMaster accounts/contacts compatibility surface without changing schema
or route contracts.

Shipped:

- People now enters through `getRemasterPeopleCompatibilityView()` in
  `lib/server/remaster-overview/index.server.ts`, which reuses the same
  compatibility overview as Home and keeps the legacy payload only for drawer
  details and Add contact form options.
- At this stage `app/people/PeopleClient.tsx` grouped cards by derived
  compatibility relationship type. P12-A later superseded the visible People
  tabs with business contact segments.
- `PersonDrawer` remains the right-side drawer; P12-D upgrades its contents
  into a relationship dossier while Workspace links still use
  `primaryContactId` through the existing `/workspace?person=...` route.
- The `/api/people` GET/POST contract and mock-mode `local-*` continuity are
  unchanged.

Out of scope:

- No DB schema change or migration.
- No route contract change.
- No worker / webhook migration.

### P10-A. ReMaster Compatibility Read Model

Status: done. Guarded by `pnpm test:home` and `pnpm build`.

Goal: start the ReMaster migration with one safe runtime slice instead of a
schema rewrite.

Shipped:

- Added `lib/remaster/read-model.ts` with a compatibility
  `RemasterDashboardOverview` made of derived accounts, contacts, and
  activities.
- Added `lib/server/remaster-overview/index.server.ts` as the server-only seam
  that composes `getPeoplePayload()` and `getDeliveryHistory()`.
- Migrated Home to consume the compatibility overview instead of reaching into
  `PeoplePayload` directly.
- Updated the Home smoke so the new ReMaster copy and account/activity framing
  are pinned.

Out of scope:

- No DB schema change.
- No route contract change.
- People, Workspace, and History follow in P10-B/P10-C/P10-D.
- No data backfill or repository rename.

## Execution Log

### P9-A. DB-backed Add Person

Status: done. Guarded by `pnpm test:db:people` and
`pnpm test:db:people-route`.

Goal: close the fake "Add someone" gap found during manual testing.

Shipped:

- `PeopleRepository.create(ownerId, input)` writes encrypted `people` rows
  under RLS and returns the normal decrypted `Person` domain shape.
- `POST /api/people` is a thin parse/auth/delegate route. DB mode writes
  through `people-create/db.server.ts`; mock mode returns a `local-*` preview
  person so the browser can keep local additions across refreshes.
- People page Add Someone now submits to `/api/people`, shows pending/error
  state, updates the list, and opens the new person's drawer.
- DB route smoke covers malformed JSON, missing name, invalid relationship
  FK, successful create, and GET-after-create.

Out of scope:

- No person update/archive.
- No occasion/date editor.
- No contact import.
- No Workspace recipient/contact model change.

### P9-B. MVP Demo Closure

Status: done. Guarded by `pnpm test:mvp-demo`, the full default
`pnpm test`, and `pnpm build`.

Goal: stop the project from feeling endless by defining one concrete demo path
and one close-out gate.

Shipped:

- `scripts/test-mvp-demo-flow.mjs` boots the mock-mode app, signs in through
  the dev session route, visits Home / People / Workspace / History / Profile,
  checks the Workspace icon fallback, creates a draft, queues a delivery,
  exercises the mock command-channel review pointer, signs out, and verifies a
  guarded page redirects back to `/signin`.
- `pnpm test:mvp-demo` is part of the default `pnpm test` chain so regressions
  in the demo path are caught with the ordinary smoke suite.
- `docs/MVP_DEMO_RUNBOOK.md` documents how to preview, demo, and freeze the
  MVP. Payments/subscriptions, mobile, WhatsApp/Slack, reminders, production
  deploy, and live status updates are named as deferred work.

Out of scope:

- No new product feature.
- No DB schema change.
- No real provider integration.
- No UI redesign.

From here, MVP work is bugfix-only unless the user explicitly reopens scope.

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
  2. Workspace's compose view used to hold client-local edits that were not
     persisted into the queued draft — P4-B/P9-C now flush subject, body, and
     card edits before queueing, but the queue is still not a sent state.

Out of scope (still future slices):

- No Gmail API send call. Queued rows wait for a worker that does not exist
  yet.
- No worker / webhook / `markStatus` wiring.
- No persistence of client-local Workspace edits — superseded by P4-B/P9-C,
  which now PATCH subject + body + card edits into a new canonical draft
  version before send.

### P4-B. Workspace Draft Edit Persistence

Status: done. Guarded by `pnpm test:drafts` (PATCH coverage in mock,
including no-op suppression, null-card path, and latest/versions
reflection) and `pnpm test:db:drafts-route` (same surface against DB
under RLS). Workspace SSR check in `pnpm test:workspace` guards the
save-status affordance.

Goal: close the "I changed the subject/body / toggled the card but the queued
delivery used the old draft" gap from P3.1, without expanding draft
authorship beyond compose text + card.

Shipped:

- `PATCH /api/drafts` with body `{ draftId, subject, paragraphs, attachedCard }`.
  Route stays thin: parse → delegate → JSON. Mock and DB dispatchers live
  behind the same seam.
- Server is authoritative: the route accepts only `draftId` + the compose
  editable fields. `personId`, `occasionId`, tone, `quickActions`, `assistantNote` are inherited from the base draft and
  cannot be overridden from the client.
- A successful edit inserts a NEW `message_drafts` row (DB) / records a
  new version in the mock store. No in-place updates of the base row,
  ever. Versions list and latest reads reflect the edit.
- Version inflation is suppressed: if `(subject, paragraphs, attachedCard)` deep-equal
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
- Workspace autosaves subject and body (700ms debounce) and card toggle
  (immediate). `queueDelivery` awaits a `flushDraftEdits()` call before
  POSTing to `/api/deliveries`; a save failure aborts the send and
  surfaces an error toast.
- Workspace renders a small save-status affordance ("Edits save
  automatically" / "Saving…" / "Saved" / "Could not save") that is
  separate from the send-queue toast. `role="status"` + `aria-live`.

Out of scope (still future slices):

- No tone editing. Body text is editable, but tone labels / quick actions
  remain generator output.
- No Gmail send worker, webhook, or `markStatus`.
- No cross-process mock persistence. The mock store is intentionally
  per-process; production-shaped flows use DB mode.
- No optimistic UI for the edited draft beyond the local subject/body/card
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

### P8-G. Command Channel Review URLs

Status: done. Guarded by `pnpm test:channels` and
`pnpm test:db:channels-inbound`.

Goal: make channel replies actionable without turning the channel into
the execution surface. A WhatsApp / Telegram / Slack style adapter can
now render a concrete ReMaster review link next to the reply text:
follow-up queries open `/people`, compose requests open `/workspace`
with encoded hint query params, and link-needed responses open
`/profile#command-channels`.

Shipped:

- `CommandResponse.reviewUrl?: string` — a relative ReMaster URL,
  deliberately separate from `suggestedAction`. `suggestedAction`
  stays semantic; `reviewUrl` is what a provider adapter can render as
  a button or link after prepending the deployment origin.
- `routeCommandEvent()` now emits:
  - `relationship_followup_query` → `/people`
  - `compose_request` → `/workspace?source=channel&recipientHint=…&contextHint=…`
  - `unknown` → no `reviewUrl`
- `handleMockInboundCommand()` emits `/profile#command-channels` for
  missing/revoked channel links.
- Profile's command-channel section has the matching
  `id="command-channels"` anchor.

Still explicitly out of scope:

- **No** real WhatsApp / Telegram / Slack adapter.
- **No** draft creation from channel messages.
- **No** queue/send/worker integration.
- **No** absolute deployment URL / app origin config yet. Real
  provider adapters may prepend their deployment origin when they land.

### P8-J. Telegram `/start` Token Link Flow

Status: done. Guarded by `pnpm test:db:channels-telegram` and
`pnpm test:db:channel-profile`.

Goal: let a user link Telegram from Profile without copying a numeric
Telegram user id. This keeps the Profile manual form as a fallback, but
adds the normal bot UX: open Telegram, send `/start <token>`, and let the
webhook bind that Telegram user to the signed-in Keepsake owner.

Shipped:

- `lib/server/channels/telegram-start-token.server.ts` — server-only
  token seam. `createTelegramStartLinkForOwner(ownerId)` renders
  `https://t.me/<TELEGRAM_BOT_USERNAME>?start=<token>`. The token is
  stateless, expires after 15 minutes, fits Telegram's 64-character
  deep-link limit, and is HMAC-SHA256 signed with
  `APP_SESSION_SIGNING_SECRET` using a Telegram-specific context string.
- `linkTelegramAccountFromStartToken(input)` verifies the token and calls
  `ChannelAccountRepository.link` with `provider: "telegram"`. Tampered
  or expired tokens return a link-needed response; a Telegram user id
  already linked to another owner returns `already_linked` and does not
  rebind the existing row.
- `lib/server/channels/telegram.server.ts` handles `/start <token>`
  before the ordinary provider identity lookup. Successful linking sends
  a Telegram reply that points back to `/profile#command-channels`.
  Responses do not echo `ownerId`.
- `lib/server/channel-accounts/profile.server.ts` includes
  `telegramStartLink` in the Profile channel view. Mock mode returns
  `null`; DB mode renders the link only when
  `TELEGRAM_BOT_USERNAME` and `APP_SESSION_SIGNING_SECRET` are configured.
- `app/profile/page.tsx` renders a "Start Telegram bot" row above the
  manual Telegram form. The manual numeric-user-id form remains as an
  operator/local fallback.
- `scripts/test-channels-telegram-db-route.mjs` covers successful
  `/start` linking, tampered-token rejection, cross-owner no-rebind, and
  a follow-up query from the newly linked Telegram user resolving to the
  owner's real fixture data.
- `scripts/test-channel-accounts-profile-db-route.mjs` covers the
  Profile start-link CTA and the Telegram deep-link length/config shape.

Still out of scope:

- **No** one-time nonce/token table. The token is stateless; replay by the
  same Telegram user is idempotent through the repository link path.
- **No** Telegram OAuth-style provider flow.
- **No** draft creation, delivery enqueue, Gmail send, or worker call from
  Profile or Telegram.
- **No** WhatsApp / Slack link UI.

### P8-I. Profile Telegram Link / Revoke UI

Status: done. Guarded by `pnpm test:db:channel-profile`.

Goal: make the first Telegram adapter usable without direct DB seeding.
This is a manual DB-mode provisioning surface and remains the fallback
now that P8-J adds the normal Telegram `/start <token>` path.

Shipped:

- `lib/server/channel-accounts/profile.server.ts` adds
  `linkTelegramChannelAccount(input)` next to the existing mock
  link path. Both provider link paths share the same validation,
  `currentUserIdOrThrow()` auth gate, and
  `ChannelAccountRepository.link` cross-owner conflict protection.
- `app/api/channels/telegram/link/route.ts` and
  `app/api/channels/telegram/revoke/route.ts` are thin POST routes
  for the Profile form. They accept JSON or form bodies, return 303
  to `/profile#command-channels` on success, and map auth/body
  failures to the same JSON code shape as the mock routes.
- `app/profile/page.tsx` now renders two DB-mode link forms:
  "Link Telegram user" (manual numeric Telegram user id) and the
  existing mock form. Rows revoke through provider-specific actions,
  so Telegram rows POST to `/api/channels/telegram/revoke`.
- `scripts/test-channel-accounts-profile-db-route.mjs` extends the
  existing Docker Profile channel smoke: Profile renders the Telegram
  form, Telegram link → row render → provider-specific revoke →
  revoked row, plus body validation and no-session 401 coverage for
  Telegram link/revoke. Existing mock link/revoke/inbound assertions
  remain.

Still out of scope:

- **No** automatic bot-link row in this slice; P8-J adds it separately.
- **No** Telegram OAuth-style provider flow.
- **No** draft creation, delivery enqueue, Gmail send, or worker call
  from Profile or Telegram.
- **No** WhatsApp / Slack link UI.

### P8-H. Telegram Command Adapter

Status: done. Guarded by `pnpm test:db:channels-telegram`.

Goal: land the first real provider route while preserving the channel
platform invariant: Telegram can be an input and reply surface, but
ReMaster web remains the execution surface.

Shipped:

- `lib/server/channels/telegram.server.ts` — server-only Telegram
  adapter. It validates `TELEGRAM_WEBHOOK_SECRET` against the official
  `X-Telegram-Bot-Api-Secret-Token` webhook header, requires
  `KEEPSAKE_DATA_SOURCE=db`, `TELEGRAM_BOT_TOKEN`, and
  `KEEPSAKE_APP_ORIGIN`, normalises Telegram text messages into
  `CommandEvent`, resolves `(provider="telegram", externalUserId)`
  through `ChannelAccountRepository.findByProviderUser` inside a
  `workerTransaction`, calls `handleOwnerCommand(ownerId, event)` for
  active links, and replies via Telegram Bot API `sendMessage`.
- `app/api/channels/telegram/route.ts` — thin POST route: parse JSON
  → service → JSON result. It does not import repositories and does not
  read web sessions.
- `.env.example` documents `TELEGRAM_WEBHOOK_SECRET`,
  `TELEGRAM_BOT_TOKEN`, `KEEPSAKE_APP_ORIGIN`, and optional
  `TELEGRAM_API_BASE`.
- `scripts/test-channels-telegram-db-route.mjs` — Docker Postgres +
  local Telegram API stub. Covers missing/wrong secret header,
  malformed JSON, ignored non-text update, unlinked link-needed reply,
  active follow-up, active compose, revoked link, owner isolation, and
  no `ownerId` echo in the real provider response.
- `package.json` adds `test:db:channels-telegram` after
  `test:db:channels-inbound`.

Still explicitly out of scope:

- **No** draft creation from Telegram.
- **No** enqueue/send/Gmail worker handoff from Telegram.
- **No** Telegram update-id dedupe table yet; current handler is
  stateless beyond `channel_accounts`.
- **No** Profile-side automatic Telegram start-link UX in this slice.
  P8-I adds manual link/revoke; P8-J adds `/start <token>` linking.
- **No** WhatsApp or Slack adapter.

### P8-F. Profile Mock Channel Link / Revoke UI

Status: done. Guarded by `pnpm test:profile` (mock-mode placeholder
assertions: section header, DB-mode-required copy, no fake linked
account, no link/revoke form) and `pnpm test:db:channel-profile`
(Docker Postgres, 35 assertions: empty-state render → link → 303 →
linked-row render → inbound resolves the same `externalUserId` to
ownerA → revoke 303 → revoked-row render → inbound now returns
`needs_link`; cross-owner revoke → 404 not_found; body validation
+ env-fallback-owner unknown id → 404).

Goal: give a dev user a real web entry point to inspect and manage
their linked command channels. Without this, the channel platform
existed end-to-end on the server but nothing in the UI exposed it.
The scope is dev/mock only — no real WhatsApp / Telegram / Slack
flows.

Shipped:

- `lib/server/channel-accounts/profile.server.ts` — new seam.
  - `getProfileChannelAccounts()` — mock mode short-circuits to an
    empty list (UI renders a placeholder; we don't fabricate
    rows); DB mode opens `transaction(ownerId, …)` and calls
    `ChannelAccountRepository.listForOwner`.
  - `linkMockChannelAccount({ externalUserId, externalThreadId?,
    displayName? })` — db-only; validates non-empty
    `externalUserId`; maps the repo's `cross_owner_conflict`
    rejection to 409 so a different owner's link can't be
    silently rebound; idempotent same-owner re-link.
  - `revokeChannelAccount({ accountId })` — db-only; validates
    UUID shape; cross-owner / unknown id → 404 `not_found` (the
    repo's `markRevoked` already throws "not found" under
    owner-scoped RLS).
- `app/api/channels/mock/link/route.ts`,
  `app/api/channels/mock/revoke/route.ts` — thin POST routes.
  Accept JSON OR `application/x-www-form-urlencoded` bodies so the
  Profile `<form method="post">` and the DB smoke share a route.
  Success → 303 redirect to `/profile`; errors → JSON with stable
  `code` field (`invalid_request` / `not_configured` /
  `cross_owner_conflict` / `not_found` / `unauthenticated` /
  `misconfigured`).
- `app/profile/page.tsx` — new "COMMAND CHANNELS" section between
  Sending and Preferences. Mock mode: a single placeholder row
  ("Command channels are available in DB mode"). DB mode: one row
  per linked account with provider label + display name +
  Active/Revoked pill + `externalUserId`, plus a revoke form for
  active rows. Below the list (always rendered in DB mode), a
  link form with `externalUserId` + optional `displayName`
  inputs. Every interactive element carries a `data-testid`
  hook + the row carries `data-channel-account-id` /
  `data-channel-status` so smoke tests can assert state without
  parsing the DOM. NO client component. NO ownerId or
  `rawProfile` leaked into the page.
- `scripts/test-profile.mjs` — +6 assertions covering the
  mock-mode placeholder (header / `data-channel-data-source="mock"`
  / "DB mode" copy / no fake rows / no link form / no revoke
  form).
- `scripts/test-channel-accounts-profile-db-route.mjs` — new
  Docker smoke. Loads schema + `db/seed_catalog.sql`; grants the
  app role read on `channel_accounts` (RW), `gmail_accounts`
  (read), `people`, `occasion_nodes`, `relationships`, `cultures`
  + the enum types `handleOwnerCommand` touches; pre-links an
  ownerB identity directly via the repo for the cross-owner
  check; boots Next dev as ownerA; mints a `keepsake_session`
  cookie; drives the full link→render→inbound→revoke→render→
  inbound round-trip + body-shape errors.
- `package.json` — `test:db:channel-profile` script spliced into
  `pnpm test:db` after `test:db:channels-inbound`. **NOT** added
  to default `pnpm test`. The mock-mode profile assertions ride
  inside `pnpm test:profile` so the default chain still pins the
  placeholder.

Out of scope (still future slices):

- **No** real WhatsApp / Telegram / Slack link flows.
- **No** OAuth / signature verification on the link/revoke
  routes — the dev user authenticates with their normal
  `keepsake_session`.
- **No** Reconnect CTA next to revoked rows (a future slice can
  add it once we have a real provider OAuth handshake to bind
  to).
- **No** draft creation. The link/revoke UI manages metadata only.
- **No** enqueue / Gmail send.
- **No** schema changes — P8-B's draft is sufficient.

### P8-E. Owner-Scoped Channel Command Read Path

Status: done. Guarded by `pnpm test:db:channels-inbound` (31
assertions — 9 new on top of P8-D's set): ownerA follow-up reply
names a real seeded fixture person + occasion label, points the user
back to Keepsake, never claims execution ("sent / delivered /
queued"); a separately-linked ownerB with NO seeded fixtures sees
the empty-window response and never leaks ownerA's fixture names
through cross-talk. Unlinked / revoked / compose paths from P8-D
stay unchanged.

Goal: with provider identity already resolved by P8-D, the channel
should answer "anyone I should follow up with?" with specifics —
names + days-until — instead of the generic acknowledgment the
keyword router emits. ReMaster web stays the place where the user
drafts and sends; the channel only points back.

Shipped:

- `lib/server/channels/command-service.server.ts` — new
  `handleOwnerCommand(ownerId, event)`. Calls `routeCommandEvent`
  for intent classification. For `relationship_followup_query`,
  opens `transaction(ownerId, …)`, reads
  `PeopleRepository.listWithRelations(ownerId, tx)`, filters
  occasions to `daysUntil >= 0 && <= 30`, sorts ascending, takes
	  the top 3, and renders a structured reply (`• <Name> —
	  <Occasion> in <N> days … Open ReMaster to review, draft, and send
	  when you're ready`). Empty window resolves to "Nothing in the next 30
	  days needs outreach review right now. Open ReMaster when you want
	  to look ahead across accounts and contacts." All other intents pass through
  untouched, so `compose_request` still returns `needs_review` +
  `recipientHint` from the keyword classifier.
- `lib/server/channels/mock-inbound.server.ts` — the active-account
  branch now calls `handleOwnerCommand(account.ownerId, event)`
  instead of `routeCommandEvent(event)` directly. The dev-only
  `ownerId` echo is preserved; the unlinked / revoked paths still
  return `needs_link` without ever touching owner data.
- `scripts/test-channels-mock-inbound-db-route.mjs` — seeds the
  standard dev fixtures (people + occasions, encrypted) for
  ownerA; links a second mock channel `mock-user-b → ownerB`
  with no fixtures; loads `db/seed_catalog.sql`; grants the app
  role read access to `people`, `occasion_nodes`, `relationships`,
  `cultures` + the enum types `listWithRelations` touches; adds
  the four ownerA-positive assertions (name / label / "Open
  Keepsake" / no execution claim) and the three ownerB-isolation
  assertions (ownerId=B, no ownerA names, empty-window text).

Out of scope (still future slices, unchanged from P8-D):

- **No** real WhatsApp / Telegram / Slack adapter.
- **No** webhook signature verification.
- **No** draft creation. `compose_request` still surfaces a hint
  only.
- **No** delivery enqueue. `/api/deliveries` stays the only queue
  boundary.
- **No** Gmail send.
- **No** Profile UI for managing linked channels.
- **No** LLM intent classifier — keyword router unchanged.
- **No** DB schema changes.

### P8-D. DB-Backed Mock Inbound Command Route

Status: done. Guarded by `pnpm test:db:channels-inbound` — Docker
Postgres + Next smoke. The test links one active mock channel account
and one revoked account through `ChannelAccountRepository.link`, then
drives `POST /api/channels/mock/inbound` in `KEEPSAKE_DATA_SOURCE=db`
mode. Assertions cover body validation, unlinked identity →
`needs_link`, revoked identity → `needs_link`, active follow-up →
`relationship_followup_query`, active compose → `compose_request` +
`needs_review`, and a regression check that the response never claims
the command was sent / delivered / queued.

Goal: prove the real provider-adapter shape without integrating a real
provider. Incoming platform identity is the auth input:
`externalUserId` resolves through `channel_accounts` under a
worker/BYPASSRLS transaction. There is NO web-session fallback and NO
`DEV_OWNER_*` fallback.

Shipped:

- `lib/server/channels/mock-inbound.server.ts` — server-only service.
  Validates `{ externalUserId, externalThreadId?, text, raw? }`;
  returns 501 `not_configured` unless `KEEPSAKE_DATA_SOURCE=db`; runs
  `workerTransaction` + `ChannelAccountRepository.findByProviderUser(
  "mock", externalUserId, tx)`; returns 200 `needs_link` when the row is
  missing or revoked; calls `routeCommandEvent()` only for active
  links. The mock/dev response echoes `ownerId` so the smoke can prove
  which owner was resolved; real provider routes must not echo owner ids.
- `app/api/channels/mock/inbound/route.ts` — thin POST route:
  malformed JSON → 400, otherwise delegate to the server seam. It does
  not import repositories and does not read current user/session.
- `scripts/test-channels-mock-inbound-db-route.mjs` — DB route smoke.
  It deliberately starts Next with `DEV_OWNER_ID` set to a different
  user and verifies an unlinked `externalUserId` still returns
  `needs_link`, proving there is no env/session fallback.
- `package.json` — `test:db:channels-inbound`, inserted into
  `pnpm test:db` after `test:db:channel-accounts`. Not part of default
  `pnpm test` because it boots Docker.

Out of scope:

- **No** WhatsApp / Telegram / Slack route.
- **No** provider signature verification or dedupe.
- **No** command execution against drafts / deliveries / workers.
- **No** DB schema change.
- **No** UI for linking or managing channel accounts.

### P8-C. ChannelAccountRepository Runtime

Status: done. Guarded by `pnpm test:db:channel-accounts` — Docker
Postgres smoke, 42 assertions: link/list/find/revoke happy paths in
both 中文 + English fixture text aren't relevant here (this slice is
DB plumbing), same-owner idempotent re-link, displayName-null clears
the encrypted column, raw `display_name_enc` bytes never contain the
plaintext name, decryption round-trips through the
`owner_id ‖ channel_accounts ‖ display_name_enc` AAD,
`external_user_id` and `raw_profile` stay plaintext (lookup key +
non-sensitive metadata), markRevoked surfaces as not-found on
unknown / cross-owner, cross-owner link attempts throw a
`cross_owner_conflict`-tagged error WITHOUT poisoning the original
row's `display_name_enc` or rebinding `owner_id`.

Goal: turn the P8-B interface design into a working Postgres
implementation so a future provider webhook can call
`ChannelAccountRepository.findByProviderUser` and resolve the owner
without going through the web session. The slice is pure plumbing —
no new routes, no provider adapters, no command execution.

Shipped:

- `lib/repositories/channel-accounts.server.ts` — new
  `PgChannelAccountRepository` + `createChannelAccountRepository()`.
  Method behaviour:
  - `findByProviderUser(provider, externalUserId, tx)` —
    throws when called without a tx (matches the
    deliveries.markStatus convention). Looks up
    `(provider, external_user_id)`, decrypts `display_name_enc`
    before returning. Worker/webhook-only.
  - `listForOwner(ownerId, tx?)` — owner-scoped under RLS.
    Returns both active and revoked rows sorted by
    `(provider, created_at, id)` so the UI can render Reconnect
    next to revoked entries.
  - `link(ownerId, input, tx?)` — elevates to `workerTransaction`
    when no tx is passed so the cross-owner detection is
    atomic. SQL is `INSERT … ON CONFLICT (provider,
    external_user_id) DO UPDATE … WHERE channel_accounts.owner_id
    = $caller`: same-owner re-link succeeds (idempotent on id;
    refreshes externalThreadId / displayName / rawProfile,
    flips status back to `active`, bumps `last_seen_at` +
    `updated_at`). Different-owner conflict produces zero
    `RETURNING` rows; the impl throws a stable
    `cross_owner_conflict`-tagged error and the existing row's
    encrypted columns stay untouched.
  - `markRevoked(ownerId, accountId, tx?)` — owner-scoped.
    Throws `target was not found` on unknown id or
    cross-owner attempt (RLS hides the row under the
    user-scoped tx; the explicit `WHERE owner_id = $caller`
    keeps the elevated-tx path honest).
- `lib/repositories/README.md` — implementation row added,
  explicitly noting `findByProviderUser`'s tx requirement and
  the elevated `workerTransaction` link strategy.
- `package.json` — `test:db:channel-accounts` script + spliced
  into `pnpm test:db` between `test:db:gmail-accounts` and
  `test:db:gmail-callback`. **NOT** added to default `pnpm test`
  (Docker required).

Out of scope (still future slices):

- **No** new API route. The P8-A mock command route still
  bypasses owner resolution by design — pre-link is a separate
  product flow.
- **No** real WhatsApp / Telegram / Slack webhook routes.
- **No** webhook signature verification (no real provider yet).
- **No** command execution against the DB.
- **No** Profile UI for managing linked channels.
- **No** seed-data row for `channel_accounts`.
- **No** schema changes — the P8-B draft was sufficient.

### P8-B. Channel Account Linking Schema + Repository Interface

Status: done. Guarded by `pnpm test:channel-accounts` — pure file-read
anchor smoke (no Docker, no DB) over `db/schema.sql`,
`lib/repositories/channel-accounts.ts`, and the docs. Asserts the
enum + table + unique index + RLS policy survive future churn, that
the repo interface keeps its four contracted methods, and that the
docs continue to call out the "external_user_id NOT encrypted" /
"display_name_enc encrypted" / "no session fallback for webhooks"
invariants.

Goal: pre-wire identity resolution for the command-channel platform
so future provider webhooks can resolve `(provider, externalUserId)
→ owner_id` BEFORE running any owner-scoped logic. P8-B is schema +
interface + docs only; no runtime repository, no route, no provider
adapter.

Shipped:

- `db/schema.sql` — new enums `channel_provider`
  (`whatsapp` / `telegram` / `slack` / `mock`) and
  `channel_account_status` (`active` / `revoked`). New table
  `channel_accounts` with `external_user_id` NOT encrypted (lookup
  key for webhook ingest), `display_name_enc` encrypted (PII), and
  a `raw_profile` jsonb gated on "non-sensitive metadata only".
  Three indexes: a partial-by-design `UNIQUE (provider,
  external_user_id)` (webhook identity), `(owner_id, provider)`
  (Profile / account management), and a partial `(provider,
  external_thread_id)` for channel-level events. RLS enabled with
  the standard `owner_id = current_user_id()` policy — webhook
  ingest runs under a BYPASSRLS worker role and uses the unique
  index directly.
- `lib/repositories/types.ts` — new domain types `ChannelProvider`,
  `ChannelAccountStatus`, `ChannelAccountId` (branded `ID`),
  `ChannelAccount` (domain view with `displayName` as decrypted
  plaintext), and `ChannelAccountLinkInput`. `ChannelProvider` is
  kept in lock-step with `lib/server/channels/types.ts` (P8-A).
- `lib/repositories/channel-accounts.ts` — pure-interface design
  for `ChannelAccountRepository`. Four methods:
  - `findByProviderUser(provider, externalUserId, tx?)` — webhook
    ingest path. No `ownerId` arg by design; the row's own
    `owner_id` is the auth proof. Contract requires
    implementations to run under BYPASSRLS and to decrypt
    `display_name_enc` before returning. Callers MUST NOT fall
    back to session / env on a `null` result.
  - `listForOwner(ownerId, tx?)` — Profile / account-management
    UI read path.
  - `link(ownerId, input, tx?)` — idempotent on
    `(provider, externalUserId, ownerId)` matches; rebind to a
    DIFFERENT owner MUST raise a conflict.
  - `markRevoked(ownerId, accountId, tx?)` — soft-revoke; row
    survives so UI can render Reconnect.
- `lib/repositories/index.ts` — barrel re-exports the new
  interface + domain types as `export type`.
- `docs/DB_SCHEMA.md` — new §3.9 with the schema block, the
  indexes-table rows, the encrypted-vs-plaintext column split
  (explicit callout that `external_user_id` and `raw_profile`
  remain plaintext, and what `raw_profile` must NOT contain), and
  the auth note.
- `docs/CURRENT_ARCHITECTURE.md` — updated the P8-A diagram + prose
  to thread `ChannelAccountRepository.findByProviderUser` between
  the provider adapter and `routeCommandEvent`. The "channel
  identity is not auth" paragraph now spells out the no-fallback
  rule.

Out of scope (still future slices):

- **No** Postgres implementation of `ChannelAccountRepository`.
- **No** new route. The mock command route (`POST /api/channels/mock`)
  still bypasses owner resolution by design.
- **No** real WhatsApp / Telegram / Slack webhook routes.
- **No** webhook signature verification (no real webhook yet).
- **No** command execution against the DB — drafts / deliveries
  remain web-only execution surfaces.
- **No** UI for managing linked channels.
- **No** migration runner or migration file. The schema lives in
  `db/schema.sql` as a design draft until the DB scripts pick it
  up.
- **No** seed data for `channel_accounts`.

### P8-A. Command Channel Foundation (provider-agnostic)

Status: done. Guarded by `pnpm test:channels` — 28 assertions across
body validation, both intent paths in 中文 + English, the unknown
fallback, and a regression check that NO response text contains
"sent" / "delivered" / "queued" (the channel layer is explicitly NOT
the execution surface).

Goal: open the door for WhatsApp / Telegram / Slack as input +
notification channels without committing to any one provider. Real
provider adapters will normalise into the same `CommandEvent` shape
and call the same `routeCommandEvent()` seam shipped here. The web
app stays the execution / review surface.

Shipped:

- `lib/server/channels/types.ts` — pure types.
  `ChannelProvider = "whatsapp" | "telegram" | "slack" | "mock"`,
  `CommandEvent` (provider + externalUserId + externalThreadId +
  text + receivedAtISO + opaque `raw`), `CommandIntent` (3 values:
  `relationship_followup_query`, `compose_request`, `unknown`), and
  `CommandResponse` (`status` discriminated union, reply `text`,
  matched `intent`, optional `suggestedAction` deep-link).
- `lib/server/channels/router.server.ts` — `routeCommandEvent`. Pure
  logic, server-only, no DB / OpenAI / queue. Keyword classifier
  with 中文 + English patterns. Compose intent wins over follow-up
  when both match. Coarse recipient extraction (中文 "给 X 发/写"
  and English "to|email|send|for X") seeds `suggestedAction.recipientHint`.
- `app/api/channels/mock/route.ts` — `POST /api/channels/mock`.
  Body validation → 400 `invalid_request`, else delegates to the
  router and returns the `CommandResponse`. Accepts only
  `provider:"mock"` (other providers will land at their own routes).
  Does NOT authenticate, does NOT touch DB, does NOT verify
  signatures (no real provider, no real signature to verify).
- `scripts/test-channels-mock-route.mjs` — boots Next dev (no
  Docker), drives the route through every validation + intent path,
  and pins the "channel layer never claims execution" rule via the
  no-"sent/delivered/queued" regex.
- `package.json` — `test:channels` script wired into default `pnpm
  test` between `test:delivery-runbook` and `test:history`. NOT in
  `pnpm test:db` (the slice doesn't touch Postgres).
- `docs/CURRENT_ARCHITECTURE.md` — replaced the previous "Future
  command channel platform" section with a P8-A foundation
  description: contract diagrams, the boundary types verbatim, the
  status-field invariant ("`needs_review` not `ok`"), and the
  provider notes (WhatsApp / Telegram / Slack) preserved as future
  guidance.

Out of scope (still future slices):

- **No** WhatsApp Business API integration.
- **No** Telegram Bot API integration.
- **No** Slack app integration.
- **No** real outbound messages — channel adapters don't send mail.
- **No** DB read/write — the router is pure logic.
- **No** OpenAI / LLM call — keyword classification only.
- **No** draft creation — `compose_request` only surfaces a hint.
- **No** delivery enqueue — `/api/deliveries` stays the only queue
  boundary.
- **No** channel-account → `owner_id` linking table.
- **No** webhook signature verification (no real webhook yet).
- **No** UI surfacing — Workspace doesn't read `suggestedAction` yet.

### P7-C. Delivery Ops Runbook + Manual Lifecycle Smoke

Status: done. Guarded by `pnpm test:delivery-runbook` (19 anchor
assertions over `docs/DELIVERY_RUNBOOK.md` — worker command, webhook
path, identity field, all three webhook events, the required env
group, every troubleshooting symptom code, and the four non-goals).
The smoke is pure file-read; no Next.js, no Docker.

Goal: turn the four-slice P7 chain (worker P5, webhook ingest P7-A,
History display P7-B) into a manually exercisable loop. Anyone with
a local Postgres and a Gmail account should be able to walk
Workspace → enqueue → `pnpm worker:run` → webhook event by curl →
refresh `/history`, and the runbook tells them which knob to turn
when each step fails.

Shipped:

- `docs/DELIVERY_RUNBOOK.md` — new doc. Four sections: env vars
  grouped by concern (app/session, DB, Gmail OAuth+send, webhook);
  the seven-step lifecycle (seed → start → sign in + connect → queue
  → drain → webhook curl → refresh History); troubleshooting tables
  keyed by *where the symptom shows up* (sign in, enqueue,
  `pnpm worker:run`, webhook, History didn't change); explicit
  non-goals (no Gmail push subscription, no cron/daemon, no
  retry/backoff/dead-letter, no live polling/SSE).
- `scripts/test-delivery-lifecycle-docs.mjs` — anchor smoke. Reads
  the runbook and asserts the critical strings survive future doc
  churn: `pnpm worker:run`, `POST /api/webhooks/deliveries`,
  `providerMessageId`, the three event values, the secret env, the
  data-source env, each 4xx/5xx webhook code, each enqueue 409 code,
  and each non-goal phrase.
- `package.json` — `test:delivery-runbook` script + spliced into the
  default `pnpm test` chain right after the worker / webhook entries.
  NOT added to `pnpm test:db`; the runbook smoke needs neither
  Docker nor Postgres.
- `docs/CURRENT_ARCHITECTURE.md` — single-line pointer added to the
  webhook section. No content duplication.

Out of scope (still future slices):

- **No** new API routes; the runbook documents existing ones only.
- **No** worker behaviour changes.
- **No** webhook contract changes — `provider:"mock"` events drive
  the local lifecycle.
- **No** DB schema changes.
- **No** UI changes.
- **No** Gmail push subscription wiring.
- **No** cron / daemon.
- **No** retry / backoff / dead-letter.

### P7-B. Surface Delivery Status in History UI

Status: done. Guarded by `pnpm test:history` (23 assertions: every row
renders, Delivered/Opened/Failed labels all present, every status
tags itself with `data-delivery-status`, failed row carries the
`ks-delivery-status--warn` class + `i-alert` icon + a non-green
colour) and `pnpm test:db:history-route` (DB-mode `/history` renders
Failed and the matching `data-delivery-status="failed"` hook).

Goal: close the visual loop opened by P7-A. The webhook can now drive
a row from `sent` to `delivered` / `opened` / `failed`, and History
needs to read that status faithfully — especially failed bounces,
which were previously rendered with the same green check as a
successful delivery.

Shipped:

- `lib/presentation.ts` — new `deliveryStatusBadge` map (label / icon
  / color / tone) for all six `DeliveryStatus` values. Three tones:
  neutral (queued, sending, sent), success (delivered, opened — both
  use `#3F9E78` green check), warn (failed — `#C2381C` red `i-alert`).
  Constants `DELIVERY_STATUS_SUCCESS_COLOR` / `_WARN_COLOR` are
  exported so future surfaces can reuse them.
- `app/history/page.tsx` — replaces the inline
  `it.status === "opened" ? "Opened" : …` block with
  `deliveryStatusBadge[it.status]`. Each status `<div>` now carries
  `data-delivery-status="<value>"` + `class="ks-delivery-status
  ks-delivery-status--<tone>"` so smoke tests can pin the tone
  family without parsing the DOM. No client component, no polling.
- `lib/mock.ts` — Jun's birthday email flipped from `opened` to
  `failed` (1 of 4 keepsakes). The row still has a real `sentAtISO`,
  so `DeliveryRepository.listByMonth`'s `sent_at IS NOT NULL` filter
  is unchanged and the DB fixture inherits the same sample via
  `scripts/seed-dev-fixtures.mjs`.
- `scripts/test-history.mjs` — adds 10 new assertions covering the
  Failed label, data-attribute hooks for all three rendered statuses,
  and that the failed row does NOT share the success green / check.
- `scripts/test-history-db-route.mjs` — DB smoke gains Failed +
  `data-delivery-status="failed"` assertions (the same Jun row,
  end-to-end through schema + seeder + repository + page).

Out of scope (still future slices):

- **No** Gmail push subscription. The webhook still accepts
  `provider:"mock"` events for tests; real Gmail wiring is its own
  slice.
- **No** retry / backoff / dead-letter for failed rows.
- **No** cron / daemon.
- **No** live updates / polling / SSE. A failed row only updates on
  page refresh.
- **No** Workspace-side delivery status timeline.
- **No** schema changes (the four columns added in P7-A cover it).
- **No** change to `/api/webhooks/deliveries`.

### P7-A. Delivery Webhook Ingest Contract

Status: done. Guarded by `pnpm test:webhook-deliveries` (default smoke,
14 assertions: secret gate + body validation + mock 404) and
`pnpm test:db:webhook-deliveries` (Docker Postgres, 36 assertions:
sent→delivered, delivered→opened, opened→delivered no-downgrade,
sent→opened skip-delivered (still stamps delivered_at), sent→failed
with reason, failed-after-open blocked with no side effects, unknown
providerMessageId → 404, wrong secret in DB mode → 401).

Goal: give external providers a way to report delivery progress
without going through user-session auth. The webhook is
provider-agnostic; identity is `provider_message_id`, the value the
worker stamped on the row when it called Gmail. This slice ships the
contract + DB path; the real Gmail push subscription, retries, and
crons are still future slices.

Shipped:

- `db/schema.sql` — `deliveries` gains four columns:
  `delivered_at timestamptz`, `opened_at timestamptz`,
  `provider_status text`, `failure_reason text`. The
  `delivery_status` enum already covered the full ladder.
- `lib/repositories/deliveries.ts` — `DeliveryRepository.markStatus`
  now takes `MarkStatusInput` (deliveryId / status /
  providerMessageId? / providerStatus? / deliveredAtISO? /
  openedAtISO? / failureReason?) and returns
  `{ updated, status }`. The contract pins the forward order
  `queued < sending < sent < delivered < opened` plus the
  side-branch terminal `failed` (writable from
  {queued, sending, sent} only).
- `lib/repositories/deliveries.server.ts` — implementation enforces
  the rank rules in one UPDATE: when the requested target would
  regress, ALL side-effect fields stay frozen (timestamps,
  provider_status, failure_reason). Idempotent same-target calls
  COALESCE in late-arriving diagnostic data without overwriting.
- `lib/server/delivery-worker/db.server.ts` — worker call sites
  migrated to the new signature; failure paths now thread the
  reason into `failure_reason` instead of dropping it.
- `lib/server/delivery-webhook/{ingest,db,mock,types}.server.ts` —
  new seam. `ingestDeliveryWebhookEvent(input)` validates the
  provider-agnostic event shape (provider ∈ {gmail, mock}, event ∈
  {delivered, opened, failed}, optional ISO `occurredAtISO`),
  dispatches by `KEEPSAKE_DATA_SOURCE`, and returns a discriminated
  result union (200 ok + {deliveryId, status, updated} / 400
  invalid_event + detail / 404 delivery_not_found / 500
  ingest_failed). NO `currentUser*` read; identity = providerMessageId.
- `app/api/webhooks/deliveries/route.ts` — thin POST route. Gates on
  `DELIVERY_WEBHOOK_SECRET` env + `x-keepsake-webhook-secret`
  header (501 when unset, 401 on mismatch), then delegates. The
  route never touches SQL.

Out of scope (still future slices):

- **No** real Gmail push subscription (the route is
  provider-agnostic so a `provider:"gmail"` event with a real
  Gmail messageId already works in DB mode; wiring Gmail's push
  pubsub topic is its own slice).
- **No** retry/backoff queue.
- **No** cron / daemon to re-drive failures.
- **No** UI changes — History page still reads status as-is.
- **No** command channels (WhatsApp/Telegram). The webhook is for
  provider delivery callbacks, not user-driven commands.
- **No** `Person.email` / `person_contacts` schema work.
- **No** provider signature / HMAC verification. Shared-secret
  header is the gate today; HMAC bodies land when a real provider
  push lands.

### P6-D. Sign-out Route + Profile Sign-out Wiring

Status: done. Guarded by `pnpm test:auth` — the new `test-signout.mjs`
script adds 14 assertions across 3 phases (signout 303 + cleared
cookie + safe / unsafe `returnTo`, Profile renders the real form
when authed and a cleared cookie immediately bounces back to
`/signin?returnTo=/profile`, signout works with no DB / Google /
Gmail env wiring).

Goal: close the session loop. After P6-D, the user can hit the
"Sign out" row in Profile and end up back on `/signin` with the
cookie cleared, without any client component, modal, or DB hit.

Shipped:

- `app/api/auth/signout/route.ts` — POST-only thin route. Clears
  `keepsake_session` (`Max-Age=0`) and 303s to `/signin`. Optional
  `?returnTo=` goes through the shared `safeReturnTo()`; unsafe
  values fall back to `/signin` (NOT `/`). Does not read the
  current user, touch the DB, revoke the Google grant, or
  disconnect Gmail.
- `lib/server/auth/require-session.server.ts` — `safeReturnTo()`
  now takes an optional `fallback` parameter so the signout route
  can use `/signin` instead of `/`. Existing callers (the
  `signinUrlFor()` helper) keep the original default.
- `app/profile/page.tsx` — the static "Sign out" row is gone. A
  new server-rendered `SignOutRow` wraps a `<form method="post" action="/api/auth/signout">`
  around a full-width submit button styled to match the existing
  settings rows. No client component, no modal.

Out of scope (still future slices):

- **No** Google grant revoke. Signout only tears down the app
  session cookie.
- **No** Gmail-account disconnect. That stays at
  `POST /api/gmail/disconnect`.
- **No** middleware. Pages still self-guard via
  `requireSessionUserOrRedirect()`.
- **No** removal of `DEV_OWNER_*` env fallback in the cookie-first
  `currentUserOrThrow()` path.
- **No** mobile-specific layout polish.
- **No** command channel / global nav logout.
- **No** DB schema changes.

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
