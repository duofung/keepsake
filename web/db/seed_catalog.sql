-- Keepsake — system catalog seed.
-- Pairs with db/schema.sql. Seeds the two catalog tables only:
--   * relationships  — preset RelationshipKinds (no user-custom rows here)
--   * cultures       — preset CultureIds (chinese, malay-muslim, indian-hindu, none)
--
-- Status: DESIGN ONLY. Not executed against any database.
--
-- This file is idempotent: every INSERT uses ON CONFLICT (id) DO UPDATE so a
-- second run reconciles seed values with whatever drifted in the DB. No user
-- data, no private content. The 5 mock people in `lib/mock.ts` stay in the
-- app layer.
--
-- Values mirror `lib/mock.ts` exactly where defined. Where a RelationshipKind
-- exists in `lib/domain.ts` but isn't yet represented in mock data, we seed
-- it with a conservative default palette + group and mark a TODO.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- §1. relationships  (10 rows — one per RelationshipKind)
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO relationships (id, kind, group_name, label, palette_bg, palette_fg, owner_id) VALUES
  -- From lib/mock.ts:
  ('rel-partner',      'partner',      'Partner',    'Partner',      '#FBE7EE', '#C24E78', NULL),
  ('rel-mother',       'mother',       'Family',     'Mother',       '#FDEBD6', '#B5832E', NULL),
  ('rel-father',       'father',       'Family',     'Father',       '#FDEBD6', '#B5832E', NULL),
  ('rel-close-friend', 'close-friend', 'Friends',    'Close friend', '#E2EEF9', '#4E80B5', NULL),
  ('rel-friend',       'friend',       'Friends',    'Friend',       '#E2EEF9', '#4E80B5', NULL),

  -- Filled in to cover the rest of RelationshipKind. Palettes are placeholders
  -- pending visual review; groups follow the obvious bucket.
  ('rel-sibling',      'sibling',      'Family',     'Sibling',      '#FDEBD6', '#B5832E', NULL),  -- TODO: confirm palette differs from parents
  ('rel-child',        'child',        'Family',     'Child',        '#FDEBD6', '#B5832E', NULL),  -- TODO: confirm palette
  ('rel-colleague',    'colleague',    'Colleagues', 'Colleague',    '#ECEEF1', '#5A6573', NULL),  -- TODO: design pass — placeholder neutral
  ('rel-mentor',       'mentor',       'Colleagues', 'Mentor',       '#ECEEF1', '#5A6573', NULL),  -- TODO: design pass — placeholder neutral
  ('rel-other',        'other',        'Friends',    'Other',        '#EFEFEF', '#5A6573', NULL)   -- TODO: 'other' has no natural group; defaulted to Friends
ON CONFLICT (id) DO UPDATE SET
  kind        = EXCLUDED.kind,
  group_name  = EXCLUDED.group_name,
  label       = EXCLUDED.label,
  palette_bg  = EXCLUDED.palette_bg,
  palette_fg  = EXCLUDED.palette_fg;
-- Note: owner_id is NOT updated on conflict. Catalog rows must stay system-owned
-- (NULL). If a row ever has a non-NULL owner_id, that's a data integrity bug
-- this seed should not paper over.

-- ═══════════════════════════════════════════════════════════════════════════
-- §2. cultures  (4 rows — one per CultureId)
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO cultures (id, label, dot_color, festivals, palette, greetings, taboos, is_system) VALUES
  (
    'chinese',
    'Chinese',
    '#E0A92E',
    ARRAY['lunar-new-year', 'qingming']::occasion_kind[],
    ARRAY['#C23A42', '#E8746B', '#E0A92E'],
    ARRAY['Gong Xi Fa Cai', 'Happy Lunar New Year'],
    ARRAY['Avoid black for celebrations (associated with mourning)'],
    true
  ),
  (
    'malay-muslim',
    'Malay · Muslim',
    '#3F9E78',
    ARRAY['hari-raya']::occasion_kind[],
    ARRAY['#3F9E78', '#E3F2EC', '#F6C99A'],
    ARRAY['Selamat Hari Raya', 'Selamat Hari Raya, maaf zahir dan batin'],
    ARRAY['No Christmas greetings', 'Keep gifts halal'],
    true
  ),
  (
    'indian-hindu',
    'Indian · Hindu',
    '#E08A2E',
    ARRAY['deepavali']::occasion_kind[],
    ARRAY['#E08A2E', '#C25A1E', '#FCE9DE'],
    ARRAY['Happy Deepavali', 'Vanakkam'],
    ARRAY[]::text[],
    true
  ),
  (
    'none',
    'No date set',
    '#888888',
    ARRAY[]::occasion_kind[],
    ARRAY[]::text[],
    ARRAY[]::text[],
    ARRAY[]::text[],
    true
  )
ON CONFLICT (id) DO UPDATE SET
  label      = EXCLUDED.label,
  dot_color  = EXCLUDED.dot_color,
  festivals  = EXCLUDED.festivals,
  palette    = EXCLUDED.palette,
  greetings  = EXCLUDED.greetings,
  taboos     = EXCLUDED.taboos,
  is_system  = EXCLUDED.is_system;

-- TODO: future culture rows planned but NOT seeded yet:
--   * 'indian-tamil' (Tamil-specific greetings/festivals beyond Hindu Deepavali)
--   * 'singapore-chinese' (subtle differences vs. mainland Chinese palette)
--   * 'indonesian-muslim' (Idul Fitri greetings, different from Malaysian)
-- These need product input on greetings/taboos before they ship — do not
-- guess them in code review.

COMMIT;
