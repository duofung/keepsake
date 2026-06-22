# Keepsake

Keepsake is a relationship-aware message assistant for remembering important
people, drafting thoughtful notes, and sending them through a review-first
workflow.

The current codebase is an MVP-quality local web app. It includes the core
desktop product flow, DB-backed seams, Gmail send queue infrastructure, and a
provider-agnostic command-channel foundation. It is not yet a production
deployment.

## What Works Today

- Home dashboard for upcoming relationship moments.
- People directory with groups, details, and add-person flow.
- Workspace for generating, editing, autosaving, and queueing message drafts.
- History timeline with delivered / opened / failed status surfaces.
- Profile page with app session, Google sign-in foundation, Gmail connect /
  disconnect, sign-out, and command-channel links.
- DB-backed Postgres schema with RLS, local fixture seed, repository runtimes,
  and smoke tests.
- Gmail delivery queue, bounded worker loop, webhook status ingest, and runbook.
- Optional OpenAI-compatible draft generator runtime.
- Mock / dev command-channel route plus DB-backed identity resolution for future
  WhatsApp, Telegram, Slack, and similar adapters.

## Repository Layout

```text
.
├── web/                    # Next.js app and all runtime code
│   ├── app/                # App Router pages and API routes
│   ├── components/         # Shared UI primitives
│   ├── db/                 # Postgres schema, catalog seed, DB README
│   ├── docs/               # Architecture, API, DB, runbooks, progress docs
│   ├── lib/                # Domain, repositories, server seams, mock data
│   └── scripts/            # Smoke, DB, fixture, worker, and env scripts
└── files/                  # Local business/deck artifacts; not app runtime
```

## Quick Start

Requirements:

- Node.js with `pnpm`
- Docker, only for DB-backed tests
- Optional: real Google / OpenAI credentials for live integrations

Run the app in mock mode:

```bash
cd web
pnpm install
pnpm env:init
pnpm dev
```

Open:

```text
http://localhost:3000
```

For local preview, the default mock/dev path is enough. Production-like DB mode
requires filling `.env.local` from `web/.env.example` and running the schema /
fixture scripts documented under `web/db/README.md`.

## Useful Commands

```bash
cd web

pnpm test          # default smoke suite, no Docker required
pnpm test:db       # DB-backed suite, uses Docker Postgres
pnpm build         # production build check
pnpm worker:run    # manually drain queued Gmail deliveries
pnpm db:seed:dev   # seed local dev fixtures after schema/catalog load
```

## Key Docs

- `web/docs/CURRENT_ARCHITECTURE.md` — current request flows and layering.
- `web/docs/DEVELOPMENT_PROGRESS.md` — project board and completed P-slices.
- `web/docs/API_CONTRACTS.md` — public route contracts.
- `web/docs/DB_SCHEMA.md` — target Postgres schema design.
- `web/docs/MVP_DEMO_RUNBOOK.md` — local MVP demo path.
- `web/docs/DELIVERY_RUNBOOK.md` — Workspace to Gmail worker to webhook loop.
- `web/lib/server/README.md` — server-only seam responsibilities.
- `web/lib/repositories/README.md` — repository boundary rules.

## Current Boundaries

Completed MVP engineering loop:

1. Sign in locally / with Google identity foundation.
2. Review people and upcoming relationship moments.
3. Generate or edit a draft in Workspace.
4. Persist draft edits.
5. Queue an email delivery.
6. Drain the queue with the worker.
7. Ingest provider status by webhook.
8. See status in History.
9. Add a new person from People.

Deferred from the MVP:

- Payments and subscriptions.
- Production deployment and CI/CD.
- Mobile-specific layout pass.
- Real WhatsApp / Slack adapters.
- Gmail push subscription setup.
- Reminder scheduler and outbound notifications.
- Rich card / attachment productization beyond the current prototype surface.

## Notes For Collaborators

- Keep server-only code under `web/lib/server/**` or repository
  `*.server.ts` implementations.
- Client components must not import server-only seams.
- Default local mode should stay mock/dev friendly.
- DB mode must use owner-scoped transactions and RLS.
- Do not commit local secrets or generated `.next` output.

