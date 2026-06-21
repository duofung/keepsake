# Keepsake MVP Demo Runbook

This is the close-out runbook for the current MVP. It freezes the demo path and
the acceptance checks that must stay green. Payments and subscriptions are
explicitly outside this MVP.

## Status

Keepsake is MVP demo-ready on desktop:

- guarded app pages: Home, People, Workspace, History, Profile
- Google identity sign-in and app session sign-out
- Gmail sender connect/disconnect
- draft generation with mock default and opt-in OpenAI-compatible runtime
- Workspace draft edit persistence and delivery queueing
- bounded Gmail delivery worker plus webhook status ingest
- History status display
- command-channel foundation with mock + Telegram adapter, review URLs, and
  owner-scoped follow-up replies

The web app remains the execution surface. Command channels can accept input and
return review pointers, but they do not send email, create deliveries, or bypass
Workspace review.

## One-Command Acceptance

Run these before calling a demo build ready:

```bash
pnpm test:mvp-demo
pnpm test
pnpm build
git diff --check
```

`pnpm test:mvp-demo` is the fastest end-to-end product smoke. It boots the app
in mock mode, signs in through the dev session route, visits all product pages,
checks the Workspace icon fallback, creates a draft, queues a delivery, exercises
the mock command-channel review pointer, signs out, and verifies guarded pages
redirect back to `/signin`.

Run the DB lifecycle separately when touching repositories, auth, Gmail, worker,
webhook, or channel identity:

```bash
pnpm test:db
```

## Local Preview

For a clean local preview without DB or external providers:

```bash
cd /Users/apple/keepsake/web
DEV_OWNER_ID=99999999-9999-4999-8999-999999999999 \
DEV_OWNER_EMAIL=arthur@example.test \
DEV_OWNER_NAME=Arthur \
APP_SESSION_SIGNING_SECRET=preview-session-secret-min-32-chars \
ENABLE_DEV_SESSION_ROUTES=1 \
KEEPSAKE_DATA_SOURCE=mock \
pnpm dev
```

`pnpm dev` clears `.next` first and then runs the env preflight. That avoids the
stale Next manifest failure that showed up during preview sessions.

Open [http://localhost:3000/signin](http://localhost:3000/signin) and use
**Continue as dev owner**.

## Demo Flow

1. Start at `/signin`; show the guarded-app loop.
2. Continue as the dev owner and land on Home.
3. Open People; show relationship groups and the person drawer.
4. Open Workspace for Lin; generate/revise the draft, edit the subject/body/card, add
   a recipient email, and click **Send email**. The correct success wording is
   "Queued...", not "Sent...".
5. Open Profile; show Gmail sender state, sign-out, and command-channel link UI.
6. Open History; show delivered/opened/failed status badges.
7. Exercise the mock command channel:

```bash
curl -sS -X POST http://localhost:3000/api/channels/mock \
  -H 'content-type: application/json' \
  -d '{"text":"最近有什么需要跟进的关系吗？"}'

curl -sS -X POST http://localhost:3000/api/channels/mock \
  -H 'content-type: application/json' \
  -d '{"text":"帮我给 Helen 发一个邮件，她今天升职了，我要祝福她"}'
```

The first response should point to `/people`; the second should be
`needs_review` and point to `/workspace`. Neither response should claim anything
was sent, delivered, or queued.

For the DB-backed delivery loop, use
[`docs/DELIVERY_RUNBOOK.md`](./DELIVERY_RUNBOOK.md).

## Freeze Rules

After this point, MVP work is bugfix-only unless the user explicitly reopens the
scope.

Allowed before a demo:

- crash fixes
- copy fixes that prevent misleading claims
- visual fixes for desktop demo breakage
- smoke-test fixes that pin real product behaviour

Deferred from this MVP:

- payments and subscriptions
- mobile responsive pass
- People CRUD/imports/calendar sync
- WhatsApp and Slack adapters
- proactive reminder scheduler
- Gmail push subscription setup
- live History polling/SSE
- production deploy, CI, migrations, logs, and hosted secrets
- retry/backoff/dead-letter queues
