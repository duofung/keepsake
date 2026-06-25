# ReMaster

ReMaster is a relationship master for account, partner, and client relationship
management. It keeps personal relationship use cases in scope, but the primary
product direction is business relationships: accounts, contacts, outreach, and
follow-up workflows.

## Why ReMaster

Important relationships do not live in one place. They are scattered across
notes, inboxes, calendars, chats, and memory. ReMaster is built to help an
operator understand who matters, what context matters, and what thoughtful next
step should happen next.

## Product Positioning

ReMaster is an account/contact intelligence workspace for relationship-driven
operators. The current product focuses on:

- Account and contact intelligence.
- Relationship notes and context.
- Outreach drafting.
- Gift, card, and follow-up workflows.
- Command channels as inbound assistants, with mock and Telegram foundations.

Command channels are review-first: they can route an inbound request to the web
workspace, but they do not directly send messages.

## Project Status

- Current state: demo-ready locally.
- Local experience: the core flow can be exercised end to end on a developer
  machine.
- Migration state: the product is moving from a Heartline / personal
  relationship narrative toward ReMaster / business relationship management.
- Runtime state: several screens use ReMaster compatibility framing while the
  underlying storage and some contracts are still legacy person-centered
  runtime surfaces.

## What Works Today

The current codebase supports:

- Home, People, Workspace, History, and Profile product surfaces.
- Google sign-in.
- Gmail sender connect / disconnect.
- Draft generation runtime with mock generation and opt-in OpenAI-compatible
  runtime.
- Delivery queue, bounded worker, webhook ingest, and History status surfacing.
- Command channel foundation.
- DB-backed mock inbound command route.
- Telegram adapter foundation, including linking and review-pointer replies.

## Tech Stack

- Next.js App Router.
- TypeScript.
- Tailwind CSS.
- Postgres.
- Docker-backed DB smoke tests.

## Local Development

```bash
cd /Users/apple/keepsake/web
pnpm install
pnpm dev
```

The app defaults to a local-friendly mock/dev posture. DB-backed flows require
the environment and schema setup documented under `web/db` and `web/docs`.

## Validation

Common checks:

```bash
cd /Users/apple/keepsake/web
pnpm test
pnpm test:db
pnpm build
```

`pnpm test:db` uses Docker-backed Postgres smoke tests.

## Repository Map

- `web/app` — Next.js App Router pages and API routes.
- `web/lib/server` — server-only orchestration seams and runtime dispatchers.
- `web/lib/repositories` — repository contracts and Postgres implementations.
- `web/db` — schema, catalog seed, and DB setup notes.
- `web/docs` — architecture, progress, API, DB, and runbook documentation.

## Current Boundaries

Not yet complete:

- Payment and subscription flows are not implemented.
- Real WhatsApp and Slack adapters are not connected.
- Command channels are still review pointers first; the web app is the execution
  surface.
- Attachments and richer asset workflows remain future product work.
- Native ReMaster account/contact/activity schema migration is still planned;
  the current runtime keeps legacy storage/contracts in several places.

## Notes For Contributors

- Keep server-only runtime code under `web/lib/server` or repository
  `*.server.ts` implementations.
- Client components should not import server-only seams.
- Preserve existing route and API contracts unless a task explicitly changes
  them.
- Do not commit local secrets, generated build output, or local business files.
