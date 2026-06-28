-- Keepsake — Postgres schema draft.
-- Pairs with docs/DB_SCHEMA.md (canonical design); this file is the SQL form.
-- Status: DESIGN ONLY. Not executed against any database.
--
-- Conventions:
--   * Per-user tables carry `owner_id` and are protected by RLS using
--     `current_user_id()` (see §1).
--   * Catalog tables (`relationships`, `cultures`) use text PKs that mirror the
--     string literals in `lib/domain.ts` (e.g. 'rel-partner', 'chinese').
--   * All timestamps are `timestamptz` in UTC. User timezone lives on `users`.
--   * Columns marked `_enc bytea` are application-encrypted before insert
--     (AES-256-GCM, envelope `nonce ‖ ciphertext ‖ tag`, AAD = owner_id ‖
--     table_name ‖ column_name). See docs/DB_SCHEMA.md §5.
--
-- This file is intended to be reviewable end-to-end. Re-running it requires
-- the destination to be empty; idempotency is the seed file's job, not this one.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- §0. Extensions
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;    -- case-insensitive email columns

-- ═══════════════════════════════════════════════════════════════════════════
-- §1. Session helper for RLS
--
-- The app sets the caller's user id per-request:
--     SET LOCAL app.user_id = '<uuid>';
-- and every RLS policy compares against current_user_id(). A NULL return
-- means "no authenticated user", which deny-by-default policies treat as
-- "see nothing".
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION current_user_id() RETURNS uuid
  LANGUAGE sql
  STABLE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- §2. Enums
--
-- Closed sets only. `cultures` stays a TABLE (not an enum) because the
-- catalog is expected to grow (Indonesia, Singapore variants).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TYPE relationship_kind AS ENUM (
  'partner', 'mother', 'father', 'sibling', 'child',
  'close-friend', 'friend', 'colleague', 'mentor', 'other'
);

CREATE TYPE relationship_group AS ENUM (
  'Partner', 'Family', 'Friends', 'Colleagues'
);

CREATE TYPE occasion_kind AS ENUM (
  'anniversary', 'birthday',
  'hari-raya', 'lunar-new-year', 'deepavali', 'qingming',
  'check-in', 'custom'
);

CREATE TYPE tone AS ENUM (
  'tender-intimate', 'playful', 'heartfelt',
  'warm-caring', 'warm-festive', 'warm-easy', 'light-warm'
);

CREATE TYPE channel         AS ENUM ('email', 'post');
-- 'sending' is the worker's claim state — set after SELECT FOR UPDATE
-- SKIP LOCKED so concurrent workers can't double-send the same row.
-- 'failed' is the terminal state for delivery attempts that exhausted
-- the worker's responsibility without delivering (auth gone, Gmail
-- refused, malformed row). No retry queue today; see delivery-worker.
CREATE TYPE delivery_status AS ENUM (
  'queued', 'sending', 'sent', 'delivered', 'opened', 'failed'
);
CREATE TYPE subscription_status AS ENUM ('free', 'plus', 'churned');
CREATE TYPE gmail_account_status AS ENUM ('connected', 'expired');
-- Provider identity for command channels (WhatsApp / Telegram / Slack /
-- the local mock route). Matches lib/server/channels/types.ts —
-- when this enum grows, update both at once.
CREATE TYPE channel_provider     AS ENUM ('whatsapp', 'telegram', 'slack', 'mock');
CREATE TYPE channel_account_status AS ENUM ('active', 'revoked');

-- TODO: `occasion_kind` will grow (Eid al-Adha, Songkran, Mid-Autumn).
-- When that begins, migrate the column from ENUM to TEXT + CHECK constraint
-- so additions are reversible. See docs/DB_SCHEMA.md §2.

-- ═══════════════════════════════════════════════════════════════════════════
-- §3. Tables
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 3.1 users
-- ───────────────────────────────────────────────────────────────────────────

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

CREATE INDEX users_subscription_idx
  ON users (subscription_status)
  WHERE subscription_status <> 'free';

-- ───────────────────────────────────────────────────────────────────────────
-- 3.2 gmail_accounts
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE gmail_accounts (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id                   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  email                      citext NOT NULL,      -- sender address shown in UI
  status                     gmail_account_status NOT NULL DEFAULT 'connected',
  scopes                     text[] NOT NULL DEFAULT '{}',
  is_primary                 boolean NOT NULL DEFAULT true,

  refresh_token_enc          bytea NOT NULL,       -- encrypted Google refresh token
  refresh_token_expires_at   timestamptz,
  last_connected_at          timestamptz NOT NULL DEFAULT now(),
  last_error                 text,

  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX gmail_accounts_owner_email_idx
  ON gmail_accounts (owner_id, email);

CREATE UNIQUE INDEX gmail_accounts_owner_primary_idx
  ON gmail_accounts (owner_id)
  WHERE is_primary;

CREATE INDEX gmail_accounts_owner_status_idx
  ON gmail_accounts (owner_id, status);

COMMENT ON COLUMN gmail_accounts.refresh_token_enc IS
  'AES-256-GCM envelope. AAD = owner_id || gmail_accounts || refresh_token_enc.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3.3 relationships  (catalog + user-customs)
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE relationships (
  id           text PRIMARY KEY,            -- 'rel-partner' (system) | 'rel-u-<uuid>' (custom)
  kind         relationship_kind  NOT NULL,
  group_name   relationship_group NOT NULL,
  label        text NOT NULL,
  palette_bg   text NOT NULL,               -- e.g. '#FBE7EE'
  palette_fg   text NOT NULL,               -- e.g. '#C24E78'

  owner_id     uuid REFERENCES users(id) ON DELETE CASCADE, -- NULL = system preset
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX relationships_owner_idx
  ON relationships (owner_id)
  WHERE owner_id IS NOT NULL;

CREATE INDEX relationships_group_idx
  ON relationships (group_name);

-- ───────────────────────────────────────────────────────────────────────────
-- 3.4 cultures  (catalog; the strategic asset)
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE cultures (
  id          text PRIMARY KEY,             -- 'chinese' | 'malay-muslim' | 'indian-hindu' | 'none'
  label       text NOT NULL,
  dot_color   text NOT NULL,
  festivals   occasion_kind[] NOT NULL DEFAULT '{}',
  palette     text[]          NOT NULL DEFAULT '{}',
  greetings   text[]          NOT NULL DEFAULT '{}',
  taboos      text[]          NOT NULL DEFAULT '{}',
  is_system   boolean         NOT NULL DEFAULT true,
  created_at  timestamptz     NOT NULL DEFAULT now()
);

-- "Find cultures that celebrate X" without a full scan.
CREATE INDEX cultures_festivals_gin
  ON cultures USING GIN (festivals);

-- TODO: when user-custom cultures land, add owner_id + RLS like relationships.
-- Until then, cultures is global read-only and RLS stays off.

-- ───────────────────────────────────────────────────────────────────────────
-- 3.5 people
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE people (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  name_enc              bytea NOT NULL,
  segment               text NOT NULL DEFAULT 'personal'
                        CHECK (segment IN ('client', 'partner', 'prospect', 'investor', 'personal')),
  organization_enc      bytea,
  role_title_enc        bytea,
  source_context_enc    bytea,
  starred               boolean NOT NULL DEFAULT false,
  avatar_bg             text NOT NULL,
  avatar_fg             text NOT NULL,

  relationship_id       text NOT NULL REFERENCES relationships(id),
  culture_id            text NOT NULL REFERENCES cultures(id),

  since_enc             bytea,
  identity_tags_enc     bytea NOT NULL,  -- encrypted JSON.stringify(string[])
  known_facts_enc       bytea NOT NULL,  -- encrypted JSON.stringify(PersonKnownFact[])
  personal_taboos_enc   bytea NOT NULL,  -- encrypted JSON.stringify(string[])
  last_contact_at       date,
  next_follow_up_at     date,
  archived_at           timestamptz,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT people_id_owner_unique UNIQUE (id, owner_id)
);

CREATE INDEX people_owner_idx
  ON people (owner_id);

CREATE INDEX people_owner_starred_idx
  ON people (owner_id, starred)
  WHERE starred;

CREATE INDEX people_owner_relationship_idx
  ON people (owner_id, relationship_id);

CREATE INDEX people_owner_segment_idx
  ON people (owner_id, segment);

CREATE INDEX people_owner_archived_idx
  ON people (owner_id, archived_at);

COMMENT ON COLUMN people.avatar_bg IS
  'Generated from name at create-time. Kept in clear so list views render '
  'without decrypting. Acceptable initial-letter entropy leak.';

COMMENT ON COLUMN people.segment IS
  'Business contact segment. Existing personal/family/friend rows default to personal.';

COMMENT ON COLUMN people.archived_at IS
  'Soft archive timestamp. Default People/Home reads hide archived rows while delivery history remains.';

-- Note: Person.nextOccasionId from domain.ts is NOT stored. Derived per-read,
-- see docs/DB_SCHEMA.md §6.

-- ───────────────────────────────────────────────────────────────────────────
-- 3.6 occasion_nodes
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE occasion_nodes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL,

  kind        occasion_kind NOT NULL,
  label_enc   bytea NOT NULL,               -- "Anniversary", "turning 62", custom labels
  detail_enc  bytea,
  date_iso    date NOT NULL,
  recurrence  text NOT NULL DEFAULT 'yearly'
              CHECK (recurrence IN ('yearly', 'lunar-yearly', 'once')),

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT occasion_nodes_person_owner_fk
    FOREIGN KEY (person_id, owner_id) REFERENCES people(id, owner_id) ON DELETE CASCADE
);

CREATE INDEX occasion_nodes_owner_date_idx
  ON occasion_nodes (owner_id, date_iso);

CREATE INDEX occasion_nodes_person_idx
  ON occasion_nodes (person_id);

CREATE INDEX occasion_nodes_person_date_idx
  ON occasion_nodes (person_id, date_iso);

-- Cross-user scheduler sweep ("what's due tomorrow across the platform?").
CREATE INDEX occasion_nodes_date_idx
  ON occasion_nodes (date_iso);

-- owner_id duplicates the owner already reachable through people. That is
-- deliberate: it gives occasion_nodes a simple RLS predicate and lets user
-- queries filter without joining through people.

-- Note: `isPrimary` from domain.ts is NOT stored. Derived as "earliest future
-- date_iso for this person". See docs/DB_SCHEMA.md §6.

-- ───────────────────────────────────────────────────────────────────────────
-- 3.7 message_drafts
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE message_drafts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id              uuid NOT NULL REFERENCES users(id)          ON DELETE CASCADE,
  person_id             uuid NOT NULL REFERENCES people(id)         ON DELETE CASCADE,
  occasion_id           uuid          REFERENCES occasion_nodes(id) ON DELETE SET NULL,

  tone                  tone NOT NULL,
  tone_label            text NOT NULL,
  alternative_tones     jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{tone, label}]

  subject_enc           bytea NOT NULL,
  paragraphs_enc        bytea NOT NULL,                      -- encrypted JSON of DraftParagraph[]
  attached_card         jsonb,                               -- AttachedCard | null (no PII)
  quick_actions         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- DraftQuickAction[] (no PII)
  assistant_note_enc    bytea NOT NULL,

  -- Provenance + cache keys (LLM swap later).
  model_provider        text,                                -- 'anthropic' | 'mock' | ...
  model_version         text,
  prompt_input_hash     text,                                -- HMAC over (person, occasion, tone, instruction)
  user_instruction_enc  bytea NOT NULL,                      -- what the user typed; '' for initial draft

  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX message_drafts_owner_person_idx
  ON message_drafts (owner_id, person_id, created_at DESC);

CREATE INDEX message_drafts_prompt_hash_idx
  ON message_drafts (prompt_input_hash)
  WHERE prompt_input_hash IS NOT NULL;

-- TODO: `attached_card.quickActions[i].prompt` is mostly generic ("Shorter",
-- "More flirty"). If we ever templatize prompts to include the recipient's
-- name, move quick_actions/attached_card under the encrypted umbrella.

-- ───────────────────────────────────────────────────────────────────────────
-- 3.8 deliveries
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE deliveries (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id                 uuid NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  -- Nullable so deleting a person/draft does not lose the history row.
  person_id                uuid REFERENCES people(id)                 ON DELETE SET NULL,
  draft_id                 uuid REFERENCES message_drafts(id)         ON DELETE SET NULL,

  recipient_name_enc       bytea NOT NULL,
  recipient_email_enc      bytea,
  recipient_address_enc    bytea,

  occasion_kind            occasion_kind NOT NULL,
  occasion_label_enc       bytea NOT NULL,
  channel                  channel NOT NULL,

  scheduled_for            timestamptz,
  sent_at                  timestamptz,
  delivered_at             timestamptz,                                -- provider webhook 'delivered' stamp
  opened_at                timestamptz,                                -- provider webhook 'opened' stamp
  status                   delivery_status NOT NULL DEFAULT 'queued',
  provider_message_id      text,                                      -- Gmail messageId / postal vendor ref
  provider_status          text,                                      -- raw provider state string (debugging)
  failure_reason           text,                                      -- terminal failure detail (worker or webhook)

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX deliveries_owner_sent_idx
  ON deliveries (owner_id, sent_at DESC);

CREATE INDEX deliveries_owner_scheduled_idx
  ON deliveries (owner_id, scheduled_for)
  WHERE status = 'queued' AND scheduled_for IS NOT NULL;

-- Webhook identity = provider_message_id. The partial UNIQUE index makes
-- that identity unambiguous (no two non-null rows can share the value)
-- AND lets multiple rows coexist while provider_message_id is still NULL
-- (the worker stamps it on the FINALISE step, not at enqueue time).
CREATE UNIQUE INDEX deliveries_provider_msg_idx
  ON deliveries (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- Send worker drains queued + sent rows; scheduled queued rows use
-- deliveries_owner_scheduled_idx.
CREATE INDEX deliveries_status_idx
  ON deliveries (status)
  WHERE status IN ('queued', 'sent');

-- ───────────────────────────────────────────────────────────────────────────
-- 3.9 channel_accounts  (P8-B command channel identity links — design draft)
-- ───────────────────────────────────────────────────────────────────────────

-- Maps a provider-side user identity (WhatsApp `wa_id`, Telegram user id,
-- Slack `team_id + user_id`, or the local mock) onto a Keepsake `owner_id`
-- so a webhook payload can resolve "who is this" BEFORE running any
-- owner-scoped logic. Channel identity is NOT web-session auth: a
-- webhook with no matching row must NOT fall back on a session cookie
-- or a `DEV_OWNER_*` env value.
--
-- `external_user_id` is intentionally NOT encrypted — webhook ingest
-- needs to look it up before any owner / DEK is in scope. Treat it like
-- an OAuth subject id: opaque, but not a secret.
--
-- `display_name_enc` IS encrypted; provider profiles often carry
-- personal names. `raw_profile` is jsonb for non-sensitive provider
-- metadata only (profile picture URL, locale, …) — adapters MUST NOT
-- drop message text, OAuth tokens, or anything PII-bearing in there.

CREATE TABLE channel_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  provider            channel_provider NOT NULL,
  external_user_id    text NOT NULL,            -- provider-side user identity (NOT encrypted)
  external_thread_id  text,                     -- conversation / chat / channel id, when applicable

  display_name_enc    bytea,                    -- AES-256-GCM(provider-side display name)

  status              channel_account_status NOT NULL DEFAULT 'active',

  raw_profile         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- non-sensitive provider metadata

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz                          -- bumped on each inbound event
);

-- One Keepsake row per (provider, external user). The unique pair is
-- what webhook ingest looks up to resolve `owner_id`.
CREATE UNIQUE INDEX channel_accounts_provider_user_idx
  ON channel_accounts (provider, external_user_id);

-- "Which channels has this owner linked?" — Profile view, future
-- account-management screens.
CREATE INDEX channel_accounts_owner_provider_idx
  ON channel_accounts (owner_id, provider);

-- "Who owns this thread/chat/channel?" — used when an event arrives
-- without an `external_user_id` (rare, but Slack channel-level
-- notifications + Telegram channel posts can hit this path).
CREATE INDEX channel_accounts_provider_thread_idx
  ON channel_accounts (provider, external_thread_id)
  WHERE external_thread_id IS NOT NULL;

COMMENT ON COLUMN channel_accounts.external_user_id IS
  'Provider-side user identity. Lookup key for webhook ingest; NOT encrypted by design.';
COMMENT ON COLUMN channel_accounts.display_name_enc IS
  'AES-256-GCM envelope. AAD = owner_id || channel_accounts || display_name_enc.';
COMMENT ON COLUMN channel_accounts.raw_profile IS
  'Non-sensitive provider metadata only. NO message text, NO tokens, NO PII secrets.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3.10 user_keys  (envelope encryption — design stub)
-- ───────────────────────────────────────────────────────────────────────────

-- TODO: docs/DB_SCHEMA.md §5 specifies envelope encryption: a per-user random
-- DEK wrapped by a KMS-held KEK. The wrapped DEK lives here. The detailed
-- shape (rotation history, retired keys, KEK ids) is intentionally minimal
-- in this draft and will be tightened when we wire the encryption service.

CREATE TABLE user_keys (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kek_id       text NOT NULL,            -- identifier of the KMS KEK that wrapped this DEK
  wrapped_dek  bytea NOT NULL,           -- KMS-wrapped data-encryption key
  created_at   timestamptz NOT NULL DEFAULT now(),
  retired_at   timestamptz               -- non-null once the DEK is rotated out
);

-- ═══════════════════════════════════════════════════════════════════════════
-- §4. Row-Level Security
--
-- Default deny: every per-user table enables RLS without a permissive base
-- policy. `current_user_id()` returning NULL → policy fails → SELECT sees no
-- rows. We never grant BYPASSRLS to the app role.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_accounts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationships   ENABLE ROW LEVEL SECURITY;
ALTER TABLE people          ENABLE ROW LEVEL SECURITY;
ALTER TABLE occasion_nodes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_drafts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliveries      ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_keys       ENABLE ROW LEVEL SECURITY;

-- cultures: catalog only, RLS intentionally OFF. See §3.4 TODO.

-- users: see only your own row.
CREATE POLICY users_self ON users
  USING      (id = current_user_id())
  WITH CHECK (id = current_user_id());

-- gmail_accounts: account metadata + encrypted provider tokens are user-owned.
CREATE POLICY gmail_accounts_owner ON gmail_accounts
  USING      (owner_id = current_user_id())
  WITH CHECK (owner_id = current_user_id());

-- relationships: see system rows + your own customs; can only write your own.
CREATE POLICY relationships_read ON relationships
  FOR SELECT
  USING (owner_id IS NULL OR owner_id = current_user_id());

CREATE POLICY relationships_write ON relationships
  FOR ALL
  USING      (owner_id IS NOT NULL AND owner_id = current_user_id())
  WITH CHECK (owner_id IS NOT NULL AND owner_id = current_user_id());

-- people / message_drafts / deliveries: simple owner_id check.
CREATE POLICY people_owner ON people
  USING      (owner_id = current_user_id())
  WITH CHECK (owner_id = current_user_id());

CREATE POLICY message_drafts_owner ON message_drafts
  USING      (owner_id = current_user_id())
  WITH CHECK (owner_id = current_user_id());

CREATE POLICY deliveries_owner ON deliveries
  USING      (owner_id = current_user_id())
  WITH CHECK (owner_id = current_user_id());

-- channel_accounts: per-owner identity links. The webhook ingest path
-- runs under a BYPASSRLS worker role (no session, no current_user_id),
-- so the policy gates the *user-facing* read path (Profile, account
-- management UI) only. The webhook path's `findByProviderUser` uses
-- the unique (provider, external_user_id) index and stays outside this
-- policy by design.
CREATE POLICY channel_accounts_owner ON channel_accounts
  USING      (owner_id = current_user_id())
  WITH CHECK (owner_id = current_user_id());

-- occasion_nodes: simple owner_id check. The composite FK above ensures the
-- owner_id matches the referenced person.
CREATE POLICY occasion_nodes_owner ON occasion_nodes
  USING      (owner_id = current_user_id())
  WITH CHECK (owner_id = current_user_id());

-- user_keys: the encryption service runs as a non-user role and is the only
-- caller. App users must never read this table.
CREATE POLICY user_keys_self ON user_keys
  USING      (user_id = current_user_id())
  WITH CHECK (user_id = current_user_id());

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- End of schema.sql.
--
-- Server-authoritative draft contract reminder
-- --------------------------------------------
-- /api/drafts only accepts { personId, occasionId, userInstruction } from the
-- client. The server JOINs people → relationships → cultures (and optionally
-- occasion_nodes) under the caller's RLS context, then writes a row into
-- message_drafts. The client never names a culture or relationship — the
-- DB is the source of truth for those.
-- ═══════════════════════════════════════════════════════════════════════════
