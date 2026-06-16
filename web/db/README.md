# `web/db/` — Keepsake schema scripts

Two SQL files plus this README. No ORM, no migration tool, no live database
connection from the app yet. The files are **design artefacts** that have
been verified against Postgres 17 once (see "Verification log" below); they
become migrations the day we wire up a real database.

## Files

| File | Purpose |
|---|---|
| [`schema.sql`](./schema.sql) | Extensions, enums, tables, indexes, the `current_user_id()` helper, and RLS policies. Runs in a single transaction. **Not idempotent** — expects an empty target. |
| [`seed_catalog.sql`](./seed_catalog.sql) | Catalog rows for `relationships` (10) and `cultures` (4). Idempotent (`ON CONFLICT (id) DO UPDATE`). Re-run anytime. |
| [`../scripts/seed-dev-fixtures.mjs`](../scripts/seed-dev-fixtures.mjs) | Local-dev fixture seed for one owner: 5 people, 7 occasions, and 4 delivery history rows. Idempotent. |
| [`README.md`](./README.md) | This file. |

The canonical design lives in [`../docs/DB_SCHEMA.md`](../docs/DB_SCHEMA.md);
this README is purely operational.

## Requirements

- **Postgres 17+** (extensions used: `pgcrypto`, `citext`; both ship with Postgres).
- Verified against `postgres:17-alpine` from Docker Hub.
- The app role used at runtime must **not** have `BYPASSRLS`. The owner role
  used to run `schema.sql` may.

## Execution order

```text
schema.sql        # once, against an empty database
seed_catalog.sql  # after schema; safe to re-run
pnpm db:seed:dev  # optional local fixtures; safe to re-run
```

Doing it in one shot against a throwaway Postgres:

```bash
# Boot a one-off container with the SQL mounted.
docker run -d --rm \
  --name keepsake-pg-test \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=keepsake \
  -p 55432:5432 \
  -v "$PWD/web/db:/sql:ro" \
  postgres:17-alpine

# Wait for it to be ready.
until docker exec keepsake-pg-test pg_isready -U postgres >/dev/null; do sleep 1; done

# Apply schema then seed.
docker exec keepsake-pg-test psql -U postgres -d keepsake \
  -v ON_ERROR_STOP=1 -f /sql/schema.sql
docker exec keepsake-pg-test psql -U postgres -d keepsake \
  -v ON_ERROR_STOP=1 -f /sql/seed_catalog.sql

# Optional: seed one local-dev owner using encrypted fixture data.
cd "$PWD/web"
DATABASE_URL=postgres://postgres:test@localhost:55432/keepsake \
DEV_ENCRYPTION_KEY_BASE64=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
pnpm db:seed:dev

# Tear it down.
docker rm -f keepsake-pg-test
```

## Local dev fixture seed

`pnpm db:seed:dev` expects `schema.sql` and `seed_catalog.sql` to have already
run. It connects with `DATABASE_URL`, upserts one dev owner, then upserts:

- 5 people from `lib/mock.ts`
- 7 occasion nodes from `lib/mock.ts`
- 4 delivery history rows from `lib/mock.ts`

The script deliberately reuses `lib/server/crypto/envelope.server.ts`, so
encrypted DB columns (`*_enc`) are seeded as AES-256-GCM envelopes rather than
plain text. `DEV_ENCRYPTION_KEY_BASE64` must decode to 32 bytes and must match
the key used by local server-side repository reads.

Default dev owner values live in `.env.example`:

```bash
DEV_OWNER_ID=00000000-0000-4000-8000-000000000001
DEV_OWNER_EMAIL=arthur@example.test
DEV_OWNER_NAME=Arthur
```

Mock string IDs such as `p-lin` and `occ-lin-anniv` are mapped to stable UUIDs
inside the seed script because the database schema uses UUID primary keys. This
is a local-dev fixture concern only; it does not change the runtime API
contracts.

The Docker-backed verification is intentionally not part of default
`pnpm test`. Run it with:

```bash
pnpm test:db:fixtures
```

## Table classification

### Catalog (global, read-mostly)

| Table | Notes |
|---|---|
| `relationships` | 10 system rows; user-customs land here with `owner_id IS NOT NULL`. RLS enforces "see system + own". |
| `cultures` | 4 system rows. RLS intentionally **off** today — public read-only. TODO when user-custom cultures ship. |

### Per-user (RLS-protected)

| Table | Policy |
|---|---|
| `users` | `id = current_user_id()` |
| `gmail_accounts` | `owner_id = current_user_id()` (sender account metadata + encrypted refresh token) |
| `people` | `owner_id = current_user_id()` |
| `occasion_nodes` | `owner_id = current_user_id()`; `(person_id, owner_id)` composite FK prevents cross-owner occasions |
| `message_drafts` | `owner_id = current_user_id()` |
| `deliveries` | `owner_id = current_user_id()` |
| `user_keys` | `user_id = current_user_id()` (envelope-encryption DEK store; design stub) |

## Testing RLS

The policies all hit `current_user_id()`, which reads `app.user_id` from a
session GUC. The runtime contract is:

```sql
-- At the start of every request, the app server runs:
SET LOCAL app.user_id = '<authenticated-user-uuid>';
```

`SET LOCAL` confines the value to the current transaction — important when
PgBouncer or another connection pool is in front of the DB.

A NULL / empty `app.user_id` makes `current_user_id()` return NULL and all
policies fail closed. Manual sanity check:

```sql
-- Run this as the app role, not as superuser (superuser bypasses RLS).
SET ROLE app_user;
SET app.user_id = '11111111-1111-1111-1111-111111111111';
SELECT count(*) FROM people;  -- only rows owned by that user

SET app.user_id = '';
SELECT count(*) FROM people;  -- 0
```

This was verified against the container during initial schema execution
(see Verification log).

## Server-authoritative draft contract

`/api/drafts` accepts only `{ personId, occasionId, userInstruction }` from
the client. The server JOINs `people → relationships → cultures` under RLS,
so the client cannot impersonate a culture or relationship the user doesn't
own. For occasions, the schema also carries `occasion_nodes.owner_id` plus a
`(person_id, owner_id)` composite foreign key, so an occasion row cannot point
at a person owned by another user.

## Verification log

First-pass verification against `postgres:17-alpine` (PostgreSQL 17.10):

- `schema.sql` — single transaction, **succeeded**. Created: 2 extensions,
  8 enums, 1 helper function, 9 tables, 20 indexes, 8 RLS-enables, 9 policies.
  Note: 20 is the number of explicit `CREATE INDEX` statements; `pg_indexes`
  reports 31 after primary-key and unique-constraint indexes are included.
- `seed_catalog.sql` — **succeeded** twice (idempotency verified): 10
  `relationships` rows, 4 `cultures` rows.
- RLS isolation — verified that user A sees their own row, user B sees 0,
  and an anonymous session (empty `app.user_id`) sees 0.
- Composite FK isolation — verified that an `occasion_nodes` row with a
  mismatched `(person_id, owner_id)` is rejected.

When migrations land for real, this README is the starting point for the
runbook.
