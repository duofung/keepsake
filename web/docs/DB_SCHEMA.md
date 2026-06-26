# Keepsake — Postgres schema (design only)

This document maps `lib/domain.ts` to a Postgres 16+ schema. It is **design intent**,
not migration code: no ORM has been adopted, no database has been provisioned. When
we do migrate, the SQL sketches below are the starting point.

Conventions:

- All per-user tables carry `owner_id uuid REFERENCES users(id) ON DELETE CASCADE`
  and are protected by Row-Level Security: `USING (owner_id = current_user_id())`.
- Primary keys: `uuid` (`gen_random_uuid()`) for user-scoped records;
  text slugs for the small catalog tables (`relationships`, `cultures`) so that
  domain-level enums (`CultureId`, `relationship.id` like `"rel-partner"`) round-trip
  intact between the API contract and the DB.
- All timestamps are `timestamptz`, stored in UTC; user timezone lives on `users`.
- `daysUntil` and `Person.nextOccasionId` are **derived** at read time
  (see §6); they are not stored columns.
- Anything in §5 marked **🔒 encrypted at rest** is application-encrypted before
  insert (see §5 for cipher + key management).
- SQL sketches assume:

  ```sql
  CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()
  CREATE EXTENSION IF NOT EXISTS citext;   -- case-insensitive emails
  ```

---

## 1. Entity overview

```
                  ┌───────────┐
                  │  users    │  ← auth subject; one row per Keepsake account
                  └─────┬─────┘
            owner_id    │
        ┌───────────────┼─────────────────┬───────────────────┬────────────────┐
        │               │                 │                   │                │
        ▼               ▼                 ▼                   ▼                ▼
┌───────────────┐ ┌──────────────────┐ ┌────────────────────┐ ┌────────────────┐
│  people       │ │  message_drafts  │ │   deliveries       │ │ gmail_accounts │
└───────┬───────┘ └────────┬─────────┘ └──────────┬─────────┘ └────────────────┘
        │ relationship_id  │ person_id                    │ person_id
        │ culture_id       │ occasion_id ─┐               │ draft_id ─┐
        │                  │              │               │           │
        ▼                  ▼              ▼               ▼           ▼
┌──────────────┐  ┌──────────────────┐  ┌──────────────┐
│ relationships│  │  occasion_nodes  │  │ (back-refs)  │
└──────────────┘  └─────────┬────────┘  └──────────────┘
                            │ person_id
                            ▼
                       people(id)

┌──────────────┐
│  cultures    │  ← catalog, referenced by people.culture_id
└──────────────┘

gmail_accounts ← sender capability; encrypted refresh token
```

---

## 2. Enums

Closed sets get Postgres `ENUM` types so the planner can reason about them and
client code can `INSERT` without escaping. Cultures stay a **table** rather than
an enum because the catalog will grow (Indonesia, Singapore variants).

```sql
CREATE TYPE relationship_kind  AS ENUM (
  'partner','mother','father','sibling','child',
  'close-friend','friend','colleague','mentor','other'
);

CREATE TYPE relationship_group AS ENUM (
  'Partner','Family','Friends','Colleagues'
);

CREATE TYPE occasion_kind AS ENUM (
  'anniversary','birthday',
  'hari-raya','lunar-new-year','deepavali','qingming',
  'check-in','custom'
);

CREATE TYPE tone AS ENUM (
  'tender-intimate','playful','heartfelt',
  'warm-caring','warm-festive','warm-easy','light-warm'
);

CREATE TYPE channel         AS ENUM ('email','post');
CREATE TYPE delivery_status AS ENUM ('queued','sent','delivered','opened');

CREATE TYPE subscription_status AS ENUM ('free','plus','churned');

CREATE TYPE gmail_account_status AS ENUM ('connected','expired');

CREATE TYPE channel_provider       AS ENUM ('whatsapp','telegram','slack','mock');
CREATE TYPE channel_account_status AS ENUM ('active','revoked');
```

> Adding a value to a Postgres enum is `ALTER TYPE ... ADD VALUE`; safe but
> non-transactional. For sets that we expect to grow within a release
> (e.g. `occasion_kind` once we add Eid al-Adha, Songkran), prefer
> `CHECK (kind IN (...))` over `ENUM` so the migration is reversible.

---

## 3. Tables

### 3.1 `users`

```sql
CREATE TABLE users (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                    citext NOT NULL UNIQUE,
  display_name             text,
  timezone                 text NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
  subscription_status      subscription_status NOT NULL DEFAULT 'free',
  subscription_renews_at   timestamptz,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX users_subscription_idx ON users(subscription_status)
  WHERE subscription_status <> 'free';
```

**Notes**
- `email` is the auth identity → indexed UNIQUE.
- Gmail capability tokens do **not** live on `users`; see `gmail_accounts`.
  This keeps auth identity separate from provider account state and allows
  reconnect/expiry/multiple-account evolution without widening the users row.
- We do not store a password (OAuth-first; magic-link fallback uses ephemeral
  tokens in a separate `auth_tokens` table not modelled here).

### 3.2 `gmail_accounts`

```sql
CREATE TABLE gmail_accounts (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id                   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  email                      citext NOT NULL,              -- sender address shown in UI
  status                     gmail_account_status NOT NULL DEFAULT 'connected',
  scopes                     text[] NOT NULL DEFAULT '{}',
  is_primary                 boolean NOT NULL DEFAULT true,

  refresh_token_enc          bytea NOT NULL,               -- 🔒 Google refresh token
  refresh_token_expires_at   timestamptz,
  last_connected_at          timestamptz NOT NULL DEFAULT now(),
  last_error                 text,

  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX gmail_accounts_owner_email_idx
  ON gmail_accounts(owner_id, email);
CREATE UNIQUE INDEX gmail_accounts_owner_primary_idx
  ON gmail_accounts(owner_id)
  WHERE is_primary;
CREATE INDEX gmail_accounts_owner_status_idx
  ON gmail_accounts(owner_id, status);
```

**Notes**
- `refresh_token_enc` is a capability token. Theft means unauthorised email
  send, so it is encrypted with the same app-layer envelope as relationship
  content.
- `email` is intentionally cleartext because Profile and Workspace display it
  as the sender. This leaks the connected sending address to a DB reader, but
  not the capability to send from it.
- `is_primary` is a forward-compatible shape for multiple senders; MVP uses
  one row. The partial unique index enforces a single primary account per
  owner.
- `status='expired'` means the account should remain visible so the user can
  reconnect. It should map to `CurrentUser.sendingAccount.status = "expired"`.
  A missing row maps to `CurrentUser.sendingAccount = null`.
- This table is **not** a send queue. It stores OAuth account state only.

### 3.3 `relationships`

Catalog table. Ships with system rows (`'rel-partner'`, `'rel-mother'`, …) and
holds user-created entries (`owner_id IS NOT NULL`).

```sql
CREATE TABLE relationships (
  id           text PRIMARY KEY,                       -- 'rel-partner' | 'rel-u-<uuid>'
  kind         relationship_kind NOT NULL,
  group_name   relationship_group NOT NULL,
  label        text NOT NULL,
  palette_bg   text NOT NULL,                          -- '#FBE7EE'
  palette_fg   text NOT NULL,                          -- '#C24E78'

  owner_id     uuid REFERENCES users(id) ON DELETE CASCADE,  -- NULL = system preset
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX relationships_owner_idx ON relationships(owner_id)
  WHERE owner_id IS NOT NULL;
CREATE INDEX relationships_group_idx ON relationships(group_name);
```

**Notes**
- The text PK matches `Relationship.id` in `domain.ts`. We get readable JOINs
  and trivial seeding.
- Palette fields are presentation, not sensitive — never encrypted.

### 3.4 `cultures`

```sql
CREATE TABLE cultures (
  id          text PRIMARY KEY,                        -- 'chinese' | 'malay-muslim' | …
  label       text NOT NULL,
  dot_color   text NOT NULL,
  festivals   occasion_kind[] NOT NULL DEFAULT '{}',
  palette     text[] NOT NULL DEFAULT '{}',
  greetings   text[] NOT NULL DEFAULT '{}',
  taboos      text[] NOT NULL DEFAULT '{}',
  is_system   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cultures_festivals_gin ON cultures USING GIN (festivals);
```

**Notes**
- `cultures` is **the product asset** — when the brief talks about "cultural
  fluency as the moat", it means this table. Read-mostly, expected to grow,
  versioned via migrations.
- `GIN` index on `festivals` supports "find cultures that celebrate X" without
  a full scan — useful when the reminder scheduler asks "for whom is `hari-raya`
  the relevant festival next week?".
- No encryption: catalog rules are not private.

### 3.5 `people`

```sql
CREATE TABLE people (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  name_enc           bytea NOT NULL,                   -- 🔒
  segment            text NOT NULL DEFAULT 'personal'
                     CHECK (segment IN ('client','partner','prospect','investor','personal')),
  organization_enc   bytea,                            -- 🔒
  role_title_enc     bytea,                            -- 🔒
  source_context_enc bytea,                            -- 🔒
  starred            boolean NOT NULL DEFAULT false,
  avatar_bg          text NOT NULL,                    -- presentational; reset on rename is fine
  avatar_fg          text NOT NULL,

  relationship_id    text NOT NULL REFERENCES relationships(id),
  culture_id         text NOT NULL REFERENCES cultures(id),

  since_enc          bytea,                            -- 🔒  "together 12 years"
  identity_tags_enc  bytea NOT NULL,                   -- 🔒  jsonb→encrypted
  known_facts_enc    bytea NOT NULL,                   -- 🔒  jsonb→encrypted
  personal_taboos_enc bytea NOT NULL,                  -- 🔒  jsonb→encrypted
  last_contact_at    date,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX people_owner_idx           ON people(owner_id);
CREATE INDEX people_owner_starred_idx   ON people(owner_id, starred)
  WHERE starred;                                          -- "Closest circle" panel
CREATE INDEX people_owner_relationship_idx
  ON people(owner_id, relationship_id);                   -- Legacy relationship lookup/filter
CREATE INDEX people_owner_segment_idx
  ON people(owner_id, segment);                           -- Business segment filter
```

**Notes**
- `segment` is the first ReMaster business contact layer on top of the current
  `Person` table. It is intentionally a checked text column, not a new account
  table or CRM pipeline. Existing personal/family/friend rows default to
  `personal`.
- The avatar palette is generated from `name` once at create time; we keep it
  alongside the encrypted name so the rail/list views can render without
  decrypting. Tradeoff: leaks ~3 bytes of entropy about the first letter.
  Acceptable for a UI affordance; revisit if a stricter threat model lands.
- `next_occasion_id` is **not** stored. See §6.
- Organization, role/title, source context, and all other free-text user
  content about another person are encrypted — the brief
  explicitly treats "your relationships stay yours" as a product promise.

### 3.6 `occasion_nodes`

```sql
CREATE TABLE occasion_nodes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_id     uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,

  kind          occasion_kind NOT NULL,
  label_enc     bytea NOT NULL,                        -- 🔒  "Anniversary", "turning 62"
  detail_enc    bytea,                                 -- 🔒
  date_iso      date NOT NULL,
  recurrence    text NOT NULL DEFAULT 'yearly'         -- 'yearly' | 'lunar-yearly' | 'once'
                CHECK (recurrence IN ('yearly','lunar-yearly','once')),

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX occasion_nodes_owner_date_idx   ON occasion_nodes(owner_id, date_iso);
CREATE INDEX occasion_nodes_person_idx       ON occasion_nodes(person_id);
CREATE INDEX occasion_nodes_person_date_idx  ON occasion_nodes(person_id, date_iso);
CREATE INDEX occasion_nodes_date_idx         ON occasion_nodes(date_iso);
```

**Notes**
- The reminder scheduler scans `occasion_nodes` by `date_iso` to find what is
  about to come due across all users → single-column index is justified despite
  the column being low-selectivity intra-row.
- `owner_id` duplicates the owner already reachable through `people`. That is
  deliberate: it gives `occasion_nodes` a simple RLS predicate and lets user
  queries filter without joining through `people`.
- `label` is encrypted because for an "anniversary" or "first chemo" custom
  occasion it leaks private context. The `kind` enum stays in the clear because
  it drives templates and is low-fidelity.
- `isPrimary` is **not** stored — derived as "earliest future date for this person".

### 3.7 `message_drafts`

```sql
CREATE TABLE message_drafts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
  person_id           uuid NOT NULL REFERENCES people(id)        ON DELETE CASCADE,
  occasion_id         uuid          REFERENCES occasion_nodes(id) ON DELETE SET NULL,

  tone                tone NOT NULL,
  tone_label          text NOT NULL,
  alternative_tones   jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{tone, label}]

  subject_enc         bytea NOT NULL,                       -- 🔒
  paragraphs_enc      bytea NOT NULL,                       -- 🔒  DraftParagraph[]
  attached_card       jsonb,                                -- AttachedCard | null
  quick_actions       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- DraftQuickAction[]
  assistant_note_enc  bytea NOT NULL,                       -- 🔒

  model_provider      text,                                 -- 'anthropic' | 'mock' | …
  model_version       text,
  prompt_input_hash   text,                                 -- for response cache

  user_instruction_enc bytea NOT NULL,                      -- 🔒  what the user typed
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX message_drafts_owner_person_idx
  ON message_drafts(owner_id, person_id, created_at DESC);
CREATE INDEX message_drafts_prompt_hash_idx
  ON message_drafts(prompt_input_hash)
  WHERE prompt_input_hash IS NOT NULL;
```

**Notes**
- The draft body is the most sensitive thing in the system. `subject`,
  `paragraphs`, `assistant_note`, and `user_instruction` are all encrypted.
- `attached_card` and `quick_actions` are **not** encrypted: they are generic
  presentation hints (palette hint, icon hint, generic labels like "Shorter")
  with no PII. Reconsider if `quickActions[].prompt` ever contains the
  recipient's name.
- `prompt_input_hash` keys a response cache once the real LLM is wired —
  same `(person_id, occasion_id, tone, instruction)` shouldn't pay twice in a
  session. Index is partial because most rows write `NULL` while we're on the
  mock generator.

### 3.8 `deliveries`

```sql
CREATE TABLE deliveries (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id                 uuid NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  person_id                uuid REFERENCES people(id)                  ON DELETE SET NULL,
  draft_id                 uuid REFERENCES message_drafts(id)          ON DELETE SET NULL,

  recipient_name_enc       bytea NOT NULL,                            -- 🔒
  recipient_email_enc      bytea,                                     -- 🔒  email channel
  recipient_address_enc    bytea,                                     -- 🔒  post channel

  occasion_kind            occasion_kind NOT NULL,
  occasion_label_enc       bytea NOT NULL,                            -- 🔒
  channel                  channel NOT NULL,

  scheduled_for            timestamptz,
  sent_at                  timestamptz,
  status                   delivery_status NOT NULL DEFAULT 'queued',
  provider_message_id      text,                                      -- Gmail messageId / postal vendor ref

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX deliveries_owner_sent_idx ON deliveries(owner_id, sent_at DESC);
CREATE INDEX deliveries_owner_scheduled_idx
  ON deliveries(owner_id, scheduled_for)
  WHERE status = 'queued' AND scheduled_for IS NOT NULL;
CREATE UNIQUE INDEX deliveries_provider_msg_idx                       -- webhook identity
  ON deliveries(provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX deliveries_status_idx
  ON deliveries(status)
  WHERE status IN ('queued','sent');                                  -- for the worker
```

**Notes**
- `person_id` and `draft_id` are nullable so deletions of a person/draft don't
  cascade-destroy the history row (`SET NULL`). The encrypted `recipient_name`
  keeps the History view rendering correctly even after the person is removed.
- The History view query is exactly `WHERE owner_id = $1 ORDER BY sent_at DESC`
  — the composite index covers it.
- Queued deliveries use `scheduled_for`; completed delivery history uses
  `sent_at`. The send worker scans `status='queued'` plus `scheduled_for`.

---

### 3.9 `channel_accounts`

Identity-link rows for command channels (WhatsApp / Telegram / Slack /
the local mock). Each row maps a single provider-side user identity
onto a Keepsake `owner_id` so a webhook payload can be resolved to
"who is this" BEFORE running any owner-scoped logic.

```sql
CREATE TABLE channel_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  provider            channel_provider NOT NULL,
  external_user_id    text NOT NULL,            -- provider-side user identity (NOT encrypted)
  external_thread_id  text,                     -- conversation / chat / channel id

  display_name_enc    bytea,                    -- AES-256-GCM(display name)

  status              channel_account_status NOT NULL DEFAULT 'active',

  raw_profile         jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz
);

CREATE UNIQUE INDEX channel_accounts_provider_user_idx
  ON channel_accounts (provider, external_user_id);                   -- webhook identity
CREATE INDEX        channel_accounts_owner_provider_idx
  ON channel_accounts (owner_id, provider);                           -- "which channels has this owner linked?"
CREATE INDEX        channel_accounts_provider_thread_idx
  ON channel_accounts (provider, external_thread_id)
  WHERE external_thread_id IS NOT NULL;                               -- channel-level events
```

**Notes**

- `external_user_id` is **intentionally NOT encrypted.** Webhook ingest
  needs to find the row before any owner / DEK is in scope. Treat the
  column like an OAuth subject id — opaque, but not a secret. The
  unique partial-by-design index `channel_accounts_provider_user_idx`
  makes the lookup unambiguous (one Keepsake link per provider+user).
- `display_name_enc` IS encrypted (PII risk — provider profiles often
  carry real names).
- `raw_profile` is `jsonb` for **non-sensitive provider metadata only**
  (locale, time zone, avatar URL). Adapters MUST NOT drop message
  text, OAuth tokens, or anything PII-bearing in there — anything that
  needs encryption goes in a typed column instead.
- **Channel identity is NOT web-session auth.** A webhook with no
  matching `channel_accounts` row MUST respond with a link-needed
  acknowledgment; it MUST NOT fall back on a `keepsake_session`
  cookie, a `DEV_OWNER_*` env value, or the request-path user. The
  RLS policy on this table gates the *user-facing* read path only
  (Profile, account management). Webhook ingest runs under the
  BYPASSRLS worker role.

---

## 4. Indexes — query-driven justification

| Screen / job | Query shape | Index used |
|---|---|---|
| Profile / Workspace sender display | `gmail_accounts` by `(owner_id, is_primary)` | `gmail_accounts_owner_primary_idx` |
| Home: people grid | `people` by `owner_id` | `people_owner_idx` |
| Home: dates coming up | `occasion_nodes` by `owner_id`, `date_iso BETWEEN now() AND now()+30d` | `occasion_nodes_owner_date_idx` |
| Home: closest circle | `people` by `(owner_id, starred=true)` | `people_owner_starred_idx` |
| People: tab counts | `people` by `(owner_id, relationship_id)` | `people_owner_relationship_idx` |
| Workspace: load latest draft | `message_drafts` by `(owner_id, person_id, created_at DESC)` LIMIT 1 | `message_drafts_owner_person_idx` |
| Workspace: response cache | `message_drafts` by `prompt_input_hash` | `message_drafts_prompt_hash_idx` |
| History: month-grouped list | `deliveries` by `(owner_id, sent_at DESC)` | `deliveries_owner_sent_idx` |
| Reminder scheduler (cron) | `occasion_nodes` by `date_iso` | `occasion_nodes_date_idx` |
| Send worker | `deliveries` by `status IN ('queued','sent')` | `deliveries_status_idx` (partial) |
| Send scheduler | `deliveries` by `(owner_id, scheduled_for)` for queued rows | `deliveries_owner_scheduled_idx` |
| Webhook ingest | `deliveries` by `provider_message_id` | `deliveries_provider_msg_idx` (partial **UNIQUE** — webhook identity is unambiguous) |
| Channel webhook identity | `channel_accounts` by `(provider, external_user_id)` | `channel_accounts_provider_user_idx` (**UNIQUE** — one Keepsake link per provider+user) |
| Profile: linked channels | `channel_accounts` by `(owner_id, provider)` | `channel_accounts_owner_provider_idx` |
| Channel-level events | `channel_accounts` by `(provider, external_thread_id)` for non-null threads | `channel_accounts_provider_thread_idx` (partial) |

---

## 5. Encryption

### What gets encrypted

| Table | Columns | Why |
|---|---|---|
| `gmail_accounts` | `refresh_token_enc` | Capability token; theft = unauthorised email send |
| `people` | `name_enc`, `since_enc`, `identity_tags_enc`, `known_facts_enc`, `personal_taboos_enc` | Free-text private context about a third party |
| `occasion_nodes` | `label_enc`, `detail_enc` | Custom labels can disclose health / relationship status |
| `message_drafts` | `subject_enc`, `paragraphs_enc`, `assistant_note_enc`, `user_instruction_enc` | The actual private writing |
| `deliveries` | `recipient_name_enc`, `recipient_email_enc`, `recipient_address_enc`, `occasion_label_enc` | The audit trail of who got what |
| `channel_accounts` | `display_name_enc` | Provider-side display name often equals a real name |

### What does NOT get encrypted

- Surrogate keys, FK ids, timestamps, booleans, enums.
- Catalog content (`relationships.*`, `cultures.*`) — not private.
- `channel_accounts.external_user_id` (provider-side identity — must be
  greppable by webhook ingest before owner / DEK is in scope).
- `channel_accounts.raw_profile` (provider metadata only; **adapters
  must keep it free of message text, tokens, or PII secrets**).
- Presentation hints on drafts (`attached_card`, `quick_actions`, `tone`,
  `tone_label`) — generic UI metadata.
- `users.email`, `gmail_accounts.email`, `gmail_accounts.status`, and
  `gmail_accounts.scopes` — needed for identity, display, and provider
  capability checks. The capability itself stays encrypted.

### Cipher

- **AES-256-GCM**, per-row 12-byte random nonce, 16-byte tag. The envelope on
  disk is `nonce ‖ ciphertext ‖ tag` packed as `bytea`. No padding; GCM is
  AEAD so length leaks but is acceptable for free-text fields of this size.
- **AAD = `owner_id ‖ table_name ‖ column_name`**, so a ciphertext copied from
  one row/column into another fails to decrypt.
- jsonb-shaped fields (`known_facts`, `paragraphs`, `identity_tags`,
  `personal_taboos`) are `JSON.stringify`'d before encryption; the column type
  is `bytea`, not `jsonb`. We lose server-side JSON queries on these — that's
  fine because they are read-back-as-a-blob in product.

### Key management

- Per-user **data-encryption key (DEK)** — random 32 bytes generated at signup,
  wrapped by a **key-encryption key (KEK)** in a KMS (AWS KMS / GCP KMS /
  Cloudflare Keyless, decided later).
- Wrapped DEK stored in a `user_keys` table (not modelled in detail yet):
  `(user_id PK, kek_id text, wrapped_dek bytea, created_at, retired_at)`.
- Rotation: issue a new DEK, re-encrypt rows in batches under the new DEK,
  retire the old DEK when migration finishes. No table-level downtime because
  the envelope carries `kek_id`.
- **Not pgcrypto.** Pgcrypto puts the key in SQL/log surface area. We want the
  plaintext key only in app memory, fetched per-request from KMS.

### Threat model the encryption is for

- Postgres backup leak / disk theft / read-replica compromise → ciphertext only.
- An attacker with app-layer code execution defeats this scheme; that's the
  honest tradeoff with envelope encryption.
- Index/sort/search on encrypted columns is impossible by design. If we need
  search on a person's name later, add a deterministic blind index column
  separately (HMAC of normalised text) — explicit opt-in, not a default.

---

## 6. Derived fields

`domain.ts` exposes two fields that the DB **does not store**:

- **`OccasionNode.daysUntil`** — computed in the API serializer as
  `(occasion.date_iso - current_date_in_user_tz)`. Stored views would go stale
  every midnight; recomputing is cheap.
- **`Person.nextOccasionId`** — derived per request:

  ```sql
  -- For a given person, "next occasion" = earliest future date.
  SELECT id
  FROM occasion_nodes
  WHERE person_id = $1
    AND date_iso >= current_date
  ORDER BY date_iso ASC
  LIMIT 1;
  ```

  Pulled in a single batch when serialising a `PeoplePayload`:

  ```sql
  SELECT DISTINCT ON (person_id) person_id, id AS next_occasion_id
  FROM occasion_nodes
  WHERE owner_id = current_user_id()
    AND person_id = ANY($1::uuid[])
    AND date_iso >= current_date
  ORDER BY person_id, date_iso ASC;
  ```

Avoiding storage removes a circular FK between `people.next_occasion_id` and
`occasion_nodes.person_id`, and removes the "did we update the cache?" failure
mode after editing an occasion.

---

## 7. `/api/drafts` — server-authoritative shape

The current contract:

```ts
interface DraftRequest {
  personId:      ID;
  occasionId:    ID | null;
  userInstruction: string;
}
```

The client **never** sends `relationship` or `cultureRule`. The server must
derive them from the DB so a client cannot, for example, submit a `culture_id`
that maps to a permissive taboo list. Resolution path:

```sql
-- Authorise the person belongs to the caller.
SELECT p.*, r.kind AS rel_kind, r.group_name AS rel_group,
       r.label AS rel_label, r.palette_bg, r.palette_fg,
       c.id AS culture_id, c.label AS culture_label,
       c.dot_color, c.festivals, c.palette, c.greetings, c.taboos
FROM people p
JOIN relationships r ON r.id = p.relationship_id
JOIN cultures      c ON c.id = p.culture_id
WHERE p.id = $1 AND p.owner_id = current_user_id();

-- Resolve the occasion if any.
SELECT id, kind, date_iso, recurrence, label_enc, detail_enc
FROM occasion_nodes
WHERE id = $2 AND person_id = $1;
```

If the occasion's `person_id` doesn't match, or the person isn't owned by the
caller, the route returns **404** (not 400). The route then decrypts the
relevant blobs, builds the LLM prompt input, and writes the resulting
`MessageDraft` back to `message_drafts` — re-encrypting the private columns.

### Why this matters for the eventual LLM swap

The mock generator in `app/api/drafts/route.ts` already takes the same inputs
the LLM will: a fully-hydrated person + relationship + culture + occasion. When
we swap, the only change is the body of `baseRecipe`/`applyInstruction`; the
request schema, authorisation check, persistence layer, and encryption surface
stay put.

---

## 8. Open questions

1. **RLS or app-only checks?** Lean RLS — defence in depth — but it requires
   a session-local `set_config('app.user_id', …)` on every request.
2. **Soft-delete?** Probably yes on `people` (paranoia about losing a
   relationship asset to a mis-click); a `deleted_at timestamptz` column,
   not modelled above.
3. **Audit log** for who saw which decrypted person row, for transparency
   ("Privacy & data" in Profile). Likely a separate `access_log` table that
   does NOT cascade — write-only.
4. **Multi-tenant (households / shared lists)?** Out of scope for MVP; the
   `owner_id` foreign key chain is what would change if we adopt this later.
5. **Search.** No full-text search planned; if added, we will likely need
   blind indexes on `people.name` and `deliveries.recipient_name` as called
   out in §5.
