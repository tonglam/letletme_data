\set ON_ERROR_STOP on

-- The fixture mutates several publication scopes and their delivery receipts.
-- Keep the complete rebuild and its assertions atomic when the file is invoked
-- directly; a failed assertion must never leave a reused database half-reset.
BEGIN;

-- Consumer contract manifests use the same lexicographic JSON canonicalization
-- as GraphQL for every non-live Data item. Keep this helper temporary so the
-- fixture derives bytes and hashes from the rows it just seeded without
-- changing the Data schema.
CREATE OR REPLACE FUNCTION pg_temp.graphql_canonical_json(value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  kind text;
BEGIN
  IF value IS NULL THEN
    RETURN 'null';
  END IF;
  kind := jsonb_typeof(value);
  IF kind = 'object' THEN
    RETURN COALESCE(
      (
        SELECT '{' || string_agg(
          to_jsonb(entry.key)::text || ':' || pg_temp.graphql_canonical_json(entry.member),
          ',' ORDER BY entry.key
        ) || '}'
        FROM jsonb_each(value) AS entry(key, member)
      ),
      '{}'
    );
  ELSIF kind = 'array' THEN
    RETURN COALESCE(
      (
        SELECT '[' || string_agg(
          pg_temp.graphql_canonical_json(entry.member),
          ',' ORDER BY entry.ordinality
        ) || ']'
        FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(member, ordinality)
      ),
      '[]'
    );
  END IF;
  RETURN value::text;
END
$$;

-- Data owns this disposable authority fixture because these INSERT shapes are
-- part of the producer schema, not the GraphQL read contract. A Data schema
-- change that adds a required producer column must update this file in the same
-- change; consumers only execute it before validating their read-only contract.
UPDATE fpl.seasons
SET is_current = FALSE
WHERE is_current;

INSERT INTO fpl.seasons (
  season_id,
  season_code,
  display_name,
  start_year,
  end_year,
  lifecycle_state,
  is_current,
  source_metadata
) VALUES (
  2026,
  '2627',
  '2026/27',
  2026,
  2027,
  'active',
  TRUE,
  '{}'::jsonb
)
ON CONFLICT (season_id) DO UPDATE
SET
  season_code = EXCLUDED.season_code,
  display_name = EXCLUDED.display_name,
  start_year = EXCLUDED.start_year,
  end_year = EXCLUDED.end_year,
  lifecycle_state = EXCLUDED.lifecycle_state,
  is_current = TRUE,
  source_metadata = '{}'::jsonb,
  updated_at = now();

DROP TABLE IF EXISTS pg_temp.graphql_core_identity;
CREATE TEMP TABLE graphql_core_identity (
  publication_id uuid PRIMARY KEY,
  revision bigint NOT NULL
);
INSERT INTO graphql_core_identity (publication_id, revision)
SELECT gen_random_uuid(), GREATEST(7::bigint, COALESCE(max(publication.revision), 0) + 1)
FROM ops.dataset_publications publication
WHERE publication.dataset = 'fpl:core'
  AND publication.season_id = 2026
  AND publication.event_id IS NULL;

DROP TABLE IF EXISTS pg_temp.graphql_core_clock;
CREATE TEMP TABLE graphql_core_clock (
  checked_at timestamptz NOT NULL
);
INSERT INTO graphql_core_clock (checked_at)
VALUES (date_trunc('second', clock_timestamp()));

UPDATE ops.dataset_publications
SET status = 'retired', retired_at = now(), updated_at = now()
WHERE dataset = 'fpl:core'
  AND season_id = 2026
  AND event_id IS NULL
  AND status = 'active';

DELETE FROM ops.data_publication_outbox outbox
USING ops.dataset_publications publication
WHERE outbox.publication_id = publication.publication_id
  AND publication.dataset = 'fpl:core'
  AND publication.season_id = 2026
  AND publication.event_id IS NULL
  AND outbox.delivered_at IS NULL
  AND outbox.status IN ('pending', 'staged', 'db_activated', 'redis_activated');

INSERT INTO ops.dataset_publications (
  publication_id,
  dataset,
  season_id,
  event_id,
  revision,
  status,
  manifest,
  activated_at
) VALUES (
  (SELECT publication_id FROM graphql_core_identity),
  'fpl:core',
  2026,
  NULL,
  (SELECT revision FROM graphql_core_identity),
  'active',
  jsonb_build_object(
    'dataset', 'fpl:core',
    'seasonCode', '2627',
    'eventId', NULL,
    'revision', (SELECT revision FROM graphql_core_identity),
    'publicationId', (SELECT publication_id::text FROM graphql_core_identity),
    'sourceCheckedAt', to_char((SELECT checked_at FROM graphql_core_clock) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'publishedAt', to_char((SELECT checked_at FROM graphql_core_clock) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'state', 'active',
    'items', jsonb_build_array(
      jsonb_build_object('name', 'events', 'key', 'llm:data:fpl:core:2627:' || (SELECT revision::text FROM graphql_core_identity) || ':events', 'type', 'string', 'count', 38, 'bytes', 20122, 'sha256', 'd309e4d39e75f55e117cee2097042846c60099a0347b1267c43b3fc715494e2b'),
      jsonb_build_object('name', 'teams', 'key', 'llm:data:fpl:core:2627:' || (SELECT revision::text FROM graphql_core_identity) || ':teams', 'type', 'string', 'count', 20, 'bytes', 6463, 'sha256', '37122f6a0f10658b23d55229d0e2d2c7be5011d60b0ddd80d7712bdf68d3d269'),
      jsonb_build_object('name', 'players', 'key', 'llm:data:fpl:core:2627:' || (SELECT revision::text FROM graphql_core_identity) || ':players', 'type', 'string', 'count', 224, 'bytes', 41014, 'sha256', 'b5e45d4b9bf0fa41b64e6b33bc83660fb067fed981ad762aa68ac2de28763c6f'),
      jsonb_build_object('name', 'phases', 'key', 'llm:data:fpl:core:2627:' || (SELECT revision::text FROM graphql_core_identity) || ':phases', 'type', 'string', 'count', 1, 'bytes', 77, 'sha256', '89153d5ae5f8600e41017e6379e2bcb20eca2d17bb1f4a0f2c85842dc8092367'),
      jsonb_build_object('name', 'fixtures', 'key', 'llm:data:fpl:core:2627:' || (SELECT revision::text FROM graphql_core_identity) || ':fixtures', 'type', 'string', 'count', 380, 'bytes', 87241, 'sha256', 'b535270fbfae6bd40d7707516f13434004180c2c5bd76986d5429dbe3744e914'),
      jsonb_build_object('name', 'currentEventId', 'key', 'llm:data:fpl:core:2627:' || (SELECT revision::text FROM graphql_core_identity) || ':currentEventId', 'type', 'string', 'count', 1, 'bytes', 1, 'sha256', 'd4735e3a265e16eee03f59718b9b5d03019c07d8b6c51f90da3a666eec13ab35'),
      jsonb_build_object('name', 'selectionRules', 'key', 'llm:data:fpl:core:2627:' || (SELECT revision::text FROM graphql_core_identity) || ':selectionRules', 'type', 'string', 'count', 0, 'bytes', 4, 'sha256', '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b')
    )
  ),
  now()
)
ON CONFLICT (publication_id) DO UPDATE
SET
  status = 'active',
  manifest = EXCLUDED.manifest,
  activated_at = now(),
  retired_at = NULL,
  updated_at = now();

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM ops.dataset_publications publication
    JOIN fpl.seasons season ON season.season_id = publication.season_id
    WHERE publication.dataset = 'fpl:core'
      AND publication.event_id IS NULL
      AND publication.status = 'active'
      AND season.is_current
      AND jsonb_array_length(publication.manifest -> 'items') = 7
  ) <> 1 THEN
    RAISE EXCEPTION 'expected one canonical core publication fixture';
  END IF;
END
$$;

-- Price Change is seeded after the Core player universe below. Each execution
-- gets a new immutable publication identity and revision; older publications
-- remain retired history so a refreshed clock cannot reuse Redis keys or a
-- publication ID that already represents a different payload.
DROP TABLE IF EXISTS pg_temp.graphql_price_change_identity;
CREATE TEMP TABLE graphql_price_change_identity (
  publication_id uuid PRIMARY KEY,
  revision bigint NOT NULL
);
INSERT INTO graphql_price_change_identity (publication_id, revision)
SELECT gen_random_uuid(), COALESCE(max(publication.revision), 0) + 1
FROM ops.dataset_publications publication
WHERE publication.dataset = 'fpl:price-changes'
  AND publication.season_id = 2026
  AND publication.event_id IS NULL;

UPDATE ops.dataset_publications
SET status = 'retired',
    retired_at = COALESCE(retired_at, now()),
    updated_at = now()
WHERE dataset = 'fpl:price-changes'
  AND season_id = 2026
  AND event_id IS NULL
  AND status = 'active';

DELETE FROM ops.data_publication_outbox outbox
USING ops.dataset_publications publication
WHERE outbox.publication_id = publication.publication_id
  AND publication.dataset = 'fpl:price-changes'
  AND publication.season_id = 2026
  AND publication.event_id IS NULL
  AND outbox.delivered_at IS NULL
  AND outbox.status IN ('pending', 'staged', 'db_activated', 'redis_activated');

-- Keep one active Briefing publication and both locale payloads available to
-- the PostgreSQL fallback contract. The payload mirrors the checked-in
-- GraphQL fixture and is intentionally empty but fully decodable. Retain the
-- publication history and allocate a strictly increasing revision on every
-- new fixture payload, matching the producer's immutable publication rule.
DROP TABLE IF EXISTS pg_temp.graphql_week_identity;
CREATE TEMP TABLE graphql_week_identity (
  publication_id uuid PRIMARY KEY,
  revision bigint NOT NULL,
  reused_active boolean NOT NULL
);
INSERT INTO graphql_week_identity (publication_id, revision, reused_active)
WITH active AS (
  SELECT publication.publication_id, publication.revision
  FROM content.publications publication
  WHERE publication.scope_key = 'week'
    AND publication.status = 'active'
    AND publication.servable
  ORDER BY publication.revision DESC
  LIMIT 1
), history AS (
  SELECT COALESCE(max(publication.revision), 0)::bigint AS max_revision
  FROM content.publications publication
  WHERE publication.scope_key = 'week'
)
SELECT
  COALESCE(active.publication_id, gen_random_uuid()),
  COALESCE(active.revision, GREATEST(1::bigint, history.max_revision + 1)),
  active.publication_id IS NOT NULL
FROM history
LEFT JOIN active ON TRUE;

UPDATE content.publications
SET status = 'retired', servable = FALSE, retired_at = COALESCE(retired_at, now())
WHERE scope_key = 'week'
  AND status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM graphql_week_identity WHERE reused_active
  );

INSERT INTO content.publications (
  publication_id,
  scope_key,
  revision,
  schema_version,
  season_code,
  target_event_id,
  event_name,
  deadline_time,
  state,
  status,
  servable,
  source_checked_at,
  published_at,
  valid_until,
  locale_manifest,
  retired_at
)
VALUES (
  (SELECT publication_id FROM graphql_week_identity),
  'week',
  (SELECT revision FROM graphql_week_identity),
  1,
  '2627',
  NULL,
  NULL,
  NULL,
  'EMPTY',
  'active',
  TRUE,
  '2026-08-10T00:00:00.000Z'::timestamptz,
  '2026-08-10T00:00:00.000Z'::timestamptz,
  NULL,
  '{}'::jsonb,
  NULL
)
ON CONFLICT (publication_id) DO NOTHING;

INSERT INTO content.publication_payloads (
  publication_id,
  locale,
  payload,
  payload_bytes,
  payload_sha256,
  created_at
)
VALUES
(
  (SELECT publication_id FROM graphql_week_identity),
  'en',
  jsonb_build_object(
    'schemaVersion', 1,
    'scopeKind', 'SURFACE',
    'scopeKey', 'week',
    'revision', (SELECT revision FROM graphql_week_identity),
    'publicationId', (SELECT publication_id::text FROM graphql_week_identity),
    'state', 'EMPTY',
    'locale', 'en',
    'publishedAt', '2026-08-10T00:00:00.000Z',
    'sourceCheckedAt', '2026-08-10T00:00:00.000Z',
    'validUntil', NULL,
    'event', NULL,
    'featured', jsonb_build_array(),
    'sections', jsonb_build_array()
  ),
  2,
  repeat('0', 64),
  '2026-08-10T00:00:00.000Z'::timestamptz
)
ON CONFLICT (publication_id, locale) DO NOTHING;

INSERT INTO content.publication_payloads (
  publication_id,
  locale,
  payload,
  payload_bytes,
  payload_sha256,
  created_at
)
VALUES (
  (SELECT publication_id FROM graphql_week_identity),
  'zh-CN',
  jsonb_build_object(
    'schemaVersion', 1,
    'scopeKind', 'SURFACE',
    'scopeKey', 'week',
    'revision', (SELECT revision FROM graphql_week_identity),
    'publicationId', (SELECT publication_id::text FROM graphql_week_identity),
    'state', 'EMPTY',
    'locale', 'zh-CN',
    'publishedAt', '2026-08-10T00:00:00.000Z',
    'sourceCheckedAt', '2026-08-10T00:00:00.000Z',
    'validUntil', NULL,
    'event', NULL,
    'featured', jsonb_build_array(),
    'sections', jsonb_build_array()
  ),
  2,
  repeat('0', 64),
  '2026-08-10T00:00:00.000Z'::timestamptz
)
ON CONFLICT (publication_id, locale) DO NOTHING;

WITH payloads AS (
  SELECT
    payload.publication_id,
    payload.locale,
    pg_temp.graphql_canonical_json(payload.payload) AS canonical
  FROM content.publication_payloads payload
  WHERE payload.publication_id = (SELECT publication_id FROM graphql_week_identity)
), proofs AS (
  SELECT
    publication_id,
    locale,
    octet_length(convert_to(canonical, 'UTF8')) AS payload_bytes,
    encode(sha256(convert_to(canonical, 'UTF8')), 'hex') AS payload_sha256
  FROM payloads
)
UPDATE content.publication_payloads payload
SET payload_bytes = proof.payload_bytes,
    payload_sha256 = proof.payload_sha256
FROM proofs proof
WHERE payload.publication_id = proof.publication_id
  AND payload.locale = proof.locale
  AND NOT EXISTS (
    SELECT 1 FROM graphql_week_identity WHERE reused_active
  );

WITH proofs AS (
  SELECT
    payload.locale,
    payload.payload_bytes,
    payload.payload_sha256
  FROM content.publication_payloads payload
  WHERE payload.publication_id = (SELECT publication_id FROM graphql_week_identity)
)
UPDATE content.publications publication
SET locale_manifest = (
      SELECT jsonb_object_agg(
        proof.locale,
        jsonb_build_object('bytes', proof.payload_bytes, 'sha256', proof.payload_sha256)
      )
      FROM proofs proof
    )
WHERE publication.publication_id = (SELECT publication_id FROM graphql_week_identity)
  AND NOT EXISTS (
    SELECT 1 FROM graphql_week_identity WHERE reused_active
  );

-- The content outbox is the durable revalidation receipt for a newly seeded
-- Week publication. A reused active publication is left untouched so the
-- fixture cannot move PostgreSQL away from a Redis pointer that already owns
-- that same publication identity.
INSERT INTO content.publication_outbox (
  outbox_id,
  event_type,
  publication_id,
  idempotency_key,
  payload,
  attempts,
  delivered_at,
  created_at
)
SELECT
  gen_random_uuid(),
  'briefing.publication.activated',
  identity.publication_id,
  'briefing:week:' || identity.publication_id::text || ':' || identity.revision::text,
  jsonb_build_object(
    'scopeKey', 'week',
    'publicationId', identity.publication_id,
    'revision', identity.revision,
    'locales', jsonb_build_array('en', 'zh-CN')
  ),
  0,
  NULL,
  clock_timestamp()
FROM graphql_week_identity identity
WHERE NOT identity.reused_active
ON CONFLICT (idempotency_key) DO UPDATE
SET publication_id = EXCLUDED.publication_id,
    payload = EXCLUDED.payload,
    attempts = 0,
    delivered_at = NULL,
    created_at = EXCLUDED.created_at;

DO $$
DECLARE
  reused_active boolean;
BEGIN
  SELECT identity.reused_active
  INTO reused_active
  FROM graphql_week_identity identity;
  IF NOT EXISTS (
    SELECT 1
    FROM content.publications publication
    JOIN content.publication_payloads payload
      ON payload.publication_id = publication.publication_id
     AND payload.locale = 'en'
    WHERE publication.publication_id = (SELECT publication_id FROM graphql_week_identity)
      AND publication.scope_key = 'week'
      AND publication.status = 'active'
      AND publication.servable
      AND publication.state = 'EMPTY'
      AND (SELECT count(*) FROM content.publication_payloads payload
           WHERE payload.publication_id = publication.publication_id) = 2
  ) THEN
    RAISE EXCEPTION 'expected complete active Briefing publication fixture';
  END IF;
  IF NOT reused_active AND NOT EXISTS (
    SELECT 1
    FROM content.publication_outbox outbox
    WHERE outbox.publication_id = (SELECT publication_id FROM graphql_week_identity)
      AND outbox.idempotency_key = 'briefing:week:'
        || (SELECT publication_id::text FROM graphql_week_identity)
        || ':' || (SELECT revision::text FROM graphql_week_identity)
      AND outbox.delivered_at IS NULL
  ) THEN
    RAISE EXCEPTION 'expected pending Week publication revalidation receipt';
  END IF;
END
$$;

-- Keep one active My FPL publication and child entry available to the
-- GraphQL reader contract. The rows are deliberately producer-owned here so
-- RLS visibility is exercised without teaching the consumer fixture how to
-- write Data tables.
INSERT INTO fpl.events (
  season_id,
  event_id,
  name,
  deadline_time,
  finished,
  data_checked,
  data_checked_at,
  is_previous,
  is_current,
  is_next
) VALUES (
  2026,
  1,
  'Gameweek 1',
  '2026-08-01T11:00:00.000Z',
  TRUE,
  TRUE,
  '2026-08-10T00:00:00.000Z',
  TRUE,
  FALSE,
  FALSE
)
ON CONFLICT (season_id, event_id) DO UPDATE
SET
  name = EXCLUDED.name,
  deadline_time = EXCLUDED.deadline_time,
  finished = EXCLUDED.finished,
  data_checked = EXCLUDED.data_checked,
  data_checked_at = EXCLUDED.data_checked_at,
  is_previous = EXCLUDED.is_previous,
  is_current = EXCLUDED.is_current,
  is_next = EXCLUDED.is_next,
  updated_at = '2026-08-10T00:00:00.000Z';

INSERT INTO fpl.events (
  season_id,
  event_id,
  name,
  deadline_time,
  finished,
  data_checked,
  data_checked_at,
  is_previous,
  is_current,
  is_next,
  updated_at
) VALUES (
  2026,
  2,
  'Gameweek 2',
  '2026-08-08T11:00:00.000Z',
  TRUE,
  TRUE,
  '2026-08-10T00:00:00.000Z',
  FALSE,
  TRUE,
  FALSE,
  '2026-08-10T00:00:00.000Z'
)
ON CONFLICT (season_id, event_id) DO UPDATE
SET
  name = EXCLUDED.name,
  deadline_time = EXCLUDED.deadline_time,
  finished = EXCLUDED.finished,
  data_checked = EXCLUDED.data_checked,
  data_checked_at = EXCLUDED.data_checked_at,
  is_previous = EXCLUDED.is_previous,
  is_current = EXCLUDED.is_current,
  is_next = EXCLUDED.is_next,
  updated_at = EXCLUDED.updated_at;

INSERT INTO fpl.events (
  season_id,
  event_id,
  name,
  deadline_time,
  finished,
  data_checked,
  data_checked_at,
  is_previous,
  is_current,
  is_next,
  updated_at
)
SELECT
  2026,
  event_id,
  format('Gameweek %s', event_id),
  '2026-08-10T11:00:00.000Z'::timestamptz + (event_id - 3) * interval '7 days',
  FALSE,
  FALSE,
  NULL,
  FALSE,
  FALSE,
  event_id = 3,
  '2026-08-10T00:00:00.000Z'::timestamptz
FROM generate_series(3, 38) AS event_id
ON CONFLICT (season_id, event_id) DO UPDATE
SET
  name = EXCLUDED.name,
  deadline_time = EXCLUDED.deadline_time,
  finished = EXCLUDED.finished,
  data_checked = EXCLUDED.data_checked,
  data_checked_at = EXCLUDED.data_checked_at,
  is_previous = EXCLUDED.is_previous,
  is_current = EXCLUDED.is_current,
  is_next = EXCLUDED.is_next,
  updated_at = EXCLUDED.updated_at;

-- Core publishes the complete event metadata object. Clear values that are
-- not represented by this fixture before constructing its authenticated
-- publication proof; otherwise a reused database can make the payload differ
-- from the deterministic authority rows below.
UPDATE fpl.events
SET average_entry_score = NULL,
    highest_scoring_entry = NULL,
    deadline_time_epoch = NULL,
    deadline_time_game_offset = NULL,
    highest_score = NULL,
    cup_league_create = FALSE,
    h2h_ko_matches_created = FALSE,
    chip_plays = '[]'::jsonb,
    most_selected = NULL,
    most_transferred_in = NULL,
    top_element = NULL,
    top_element_info = NULL,
    transfers_made = NULL,
    most_captained = NULL,
    most_vice_captained = NULL,
    updated_at = '2026-08-10T00:00:00.000Z'::timestamptz
WHERE season_id = 2026;

DO $$
BEGIN
  -- competition.tournaments.tournament_id is a global primary key, so the
  -- fixture must fail closed instead of accidentally reusing another season's
  -- identities. These high sentinels are reserved for this disposable contract.
  IF EXISTS (
    SELECT 1
    FROM competition.tournaments
    WHERE tournament_id IN (2147483000, 2147483001)
      AND season_id <> 2026
  ) THEN
    RAISE EXCEPTION 'reserved GraphQL contract tournament identity is already used by another season';
  END IF;
  IF (SELECT count(*) FROM fpl.events WHERE season_id = 2026) <> 38 THEN
    RAISE EXCEPTION 'GraphQL contract fixture requires exactly 38 events in season 2026';
  END IF;
END
$$;

DROP TABLE IF EXISTS pg_temp.graphql_live_identity;
CREATE TEMP TABLE graphql_live_identity (
  publication_id uuid PRIMARY KEY,
  generation bigint NOT NULL
);
INSERT INTO graphql_live_identity (publication_id, generation)
SELECT gen_random_uuid(), COALESCE(max(checkpoint.generation), 0) + 1
FROM competition.live_points_publication_checkpoints checkpoint
WHERE checkpoint.season_id = 2026
  AND checkpoint.event_id = 1;

DROP TABLE IF EXISTS pg_temp.graphql_live_clock;
CREATE TEMP TABLE graphql_live_clock (
  checked_at timestamptz NOT NULL
);
INSERT INTO graphql_live_clock (checked_at)
VALUES (date_trunc('second', clock_timestamp()));

-- Define the Live publication transaction before the Core rows are seeded, but
-- invoke it only after the complete player and fixture identity arrays below
-- exist. This keeps the persisted payload and its proof producer-consistent on
-- a fresh migration as well as on a rerun.
CREATE OR REPLACE FUNCTION pg_temp.seed_graphql_live_authority()
RETURNS void
LANGUAGE plpgsql
AS $graphql_live$
BEGIN
  -- Keep one immutable event-1 Live publication available to the PostgreSQL
  -- fallback contract. Build it from the same current-season player and event-1
  -- fixture identities that the supported publisher receives from FPL; the item
  -- proof is derived from the resulting JSONB payloads. Each rerun allocates a
  -- fresh publication identity and a generation above the existing history so
  -- a retained Redis publication can never be overwritten by an older fixture.
DELETE FROM ops.data_publication_outbox outbox
USING ops.dataset_publications publication
WHERE outbox.publication_id = publication.publication_id
  AND publication.dataset = 'fpl:live'
  AND publication.season_id = 2026
  AND publication.event_id = 1
  AND outbox.delivered_at IS NULL
  AND outbox.status IN ('pending', 'staged', 'db_activated', 'redis_activated');

DELETE FROM ops.dataset_publication_items item
USING ops.dataset_publications publication
WHERE item.publication_id = publication.publication_id
  AND publication.dataset = 'fpl:live'
  AND publication.season_id = 2026
  AND publication.event_id = 1;

DELETE FROM ops.dataset_publications
WHERE dataset = 'fpl:live'
  AND season_id = 2026
  AND event_id = 1;

  -- Finalization is only truthful when the complete event-live payload is also
  -- durable. Rebuild the disposable event-1 fact set and use one captured
  -- checkpoint for row timestamps and the event markers, matching the producer
  -- transaction that writes FINALIZED.
  --
  -- This fixture owns the full refresh input scope. Clear retained downstream
  -- rows before deleting provider facts (the Player State projection has an
  -- FK to Understat player seasons), then reseed the one canonical event-1
  -- source below. Without this reset, a reused database can leak event-2
  -- stats or verified 2627 Understat links into the refreshed projection.
  DELETE FROM reporting.player_state_season_rows
  WHERE season_code = '2627';

  DELETE FROM fpl.player_gameweek_scoring_items
  WHERE season_id = 2026;

  DELETE FROM fpl.player_gameweek_stats
  WHERE season_id = 2026;

  DELETE FROM understat.player_team_seasons
  WHERE season_code = '2627';

  DELETE FROM understat.player_seasons
  WHERE season_code = '2627';

  -- bridge.entity_links is global. Preserve multi-season mappings in a
  -- temporary table while the season-local Player State refresh runs. The
  -- refresh selects a link before checking confirmedSeasons, so leaving a
  -- shared row visible would publish UNVERIFIED instead of fresh-install
  -- UNAVAILABLE. Restore each captured row byte-for-byte after the refresh so
  -- the next rerun sees the same multi-season evidence.
  DROP TABLE IF EXISTS pg_temp.graphql_shared_player_links;
  CREATE TEMP TABLE graphql_shared_player_links AS
  SELECT link.*
  FROM bridge.entity_links link
  WHERE link.entity_type = 'player'
    AND link.left_provider = 'understat'
    AND link.right_provider = 'fpl'
    AND jsonb_typeof(link.evidence -> 'confirmedSeasons') = 'array'
    AND link.evidence -> 'confirmedSeasons' ? '2627'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(link.evidence -> 'confirmedSeasons') AS season(value)
      WHERE season.value <> '2627'
    );

  DELETE FROM bridge.entity_links
  WHERE entity_type = 'player'
    AND left_provider = 'understat'
    AND right_provider = 'fpl'
    AND jsonb_typeof(evidence -> 'confirmedSeasons') = 'array'
    AND evidence -> 'confirmedSeasons' ? '2627';

  UPDATE understat.seasons
  SET updated_at = '2026-08-10T00:00:00.000Z'::timestamptz
  WHERE season_code = '2627';

INSERT INTO fpl.player_gameweek_stats (
  season_id,
  event_id,
  element_id,
  minutes,
  goals_scored,
  assists,
  clean_sheets,
  goals_conceded,
  own_goals,
  penalties_saved,
  penalties_missed,
  yellow_cards,
  red_cards,
  saves,
  bonus,
  bps,
  starts,
  expected_goals,
  expected_assists,
  expected_goal_involvements,
  expected_goals_conceded,
  in_dream_team,
  total_points,
  defensive_contribution,
  created_at,
  updated_at
)
SELECT
  2026,
  1,
  player.element_id,
  90,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  TRUE,
  0.00,
  0.00,
  0.00,
  0.00,
  FALSE,
  CASE WHEN player.element_id = 1 THEN 42 ELSE 0 END,
  0,
  '2026-08-10T00:00:00.000Z'::timestamptz,
  '2026-08-10T00:00:00.000Z'::timestamptz
FROM fpl.players player
WHERE player.season_id = 2026;

UPDATE fpl.events
SET live_snapshot_checked_at = '2026-08-10T00:00:00.000Z'::timestamptz,
    live_snapshot_finalized_at = '2026-08-10T00:00:00.000Z'::timestamptz,
    live_facts_persisted_at = '2026-08-10T00:00:00.000Z'::timestamptz
WHERE season_id = 2026 AND event_id = 1;

DO $$
BEGIN
  IF (SELECT count(*) FROM fpl.player_gameweek_stats WHERE season_id = 2026 AND event_id = 1) <> 224 THEN
    RAISE EXCEPTION 'GraphQL contract fixture requires exactly 224 durable event-live rows';
  END IF;
END
$$;

-- The event-live explain projection is a separate producer-owned source. Only
-- element 1 has authenticated fixture-breakdown evidence in this fixture, so
-- persist its minutes item and leave the other players' scoring scope empty;
-- a scoring row without corresponding breakdown evidence is not producer-
-- consistent.
INSERT INTO fpl.player_gameweek_scoring_items (
  season_id,
  event_id,
  element_id,
  scoring_identifier,
  scoring_value,
  points,
  created_at,
  updated_at
)
SELECT
  2026,
  1,
  player.element_id,
  'minutes',
  90,
  2,
  '2026-08-10T00:00:00.000Z'::timestamptz,
  '2026-08-10T00:00:00.000Z'::timestamptz
FROM fpl.players player
WHERE player.season_id = 2026
  AND player.element_id = 1;

DO $$
BEGIN
  IF (SELECT count(*)
      FROM fpl.player_gameweek_scoring_items
      WHERE season_id = 2026 AND event_id = 1) <> 1
    OR NOT EXISTS (
      SELECT 1
      FROM fpl.player_gameweek_scoring_items
      WHERE season_id = 2026
        AND event_id = 1
        AND element_id = 1
        AND scoring_identifier = 'minutes'
        AND scoring_value = 90
        AND points = 2
    ) THEN
    RAISE EXCEPTION 'GraphQL contract fixture requires canonical event-live scoring items';
  END IF;
END
$$;

DROP TABLE IF EXISTS pg_temp.graphql_live_items;
CREATE TEMP TABLE graphql_live_items (
  item_name text PRIMARY KEY,
  payload jsonb NOT NULL,
  item_count integer NOT NULL,
  canonical text NOT NULL,
  payload_bytes integer NOT NULL,
  checksum text NOT NULL
);

WITH event_lives AS (
  SELECT jsonb_agg(
    jsonb_build_object(
      'eventId', 1,
      'elementId', player.element_id,
      'minutes', 90,
      'goalsScored', 0,
      'assists', 0,
      'cleanSheets', 1,
      'goalsConceded', 0,
      'ownGoals', 0,
      'penaltiesSaved', 0,
      'penaltiesMissed', 0,
      'yellowCards', 0,
      'redCards', 0,
      'saves', 0,
      'bonus', 0,
      'bps', 0,
      'defensiveContribution', 0,
      'starts', TRUE,
      'expectedGoals', '0.00',
      'expectedAssists', '0.00',
      'expectedGoalInvolvements', '0.00',
      'expectedGoalsConceded', '0.00',
      'inDreamTeam', FALSE,
      'totalPoints', CASE WHEN player.element_id = 1 THEN 42 ELSE 0 END,
      'createdAt', NULL,
      'fixtureBreakdown', CASE WHEN player.element_id = 1 THEN jsonb_build_array(
        jsonb_build_object(
          'fixtureId', 1,
          'stats', jsonb_build_array(
            jsonb_build_object('identifier', 'assists', 'value', 0, 'points', 0, 'pointsModification', NULL),
            jsonb_build_object('identifier', 'goals_scored', 'value', 0, 'points', 0, 'pointsModification', NULL),
            jsonb_build_object('identifier', 'minutes', 'value', 90, 'points', 2, 'pointsModification', NULL),
            jsonb_build_object('identifier', 'own_goals', 'value', 0, 'points', 0, 'pointsModification', NULL),
            jsonb_build_object('identifier', 'red_cards', 'value', 0, 'points', 0, 'pointsModification', NULL),
            jsonb_build_object('identifier', 'starts', 'value', 1, 'points', 0, 'pointsModification', NULL),
            jsonb_build_object('identifier', 'yellow_cards', 'value', 0, 'points', 0, 'pointsModification', NULL)
          )
        )
      ) ELSE jsonb_build_array() END
    ) ORDER BY player.element_id
  ) AS payload
  FROM fpl.players player
  WHERE player.season_id = 2026
), fixtures AS (
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', fixture.fixture_id,
      'code', fixture.code,
      'event', fixture.event_id,
      'finished', fixture.finished,
      'finishedProvisional', fixture.finished_provisional,
      'kickoffTime', to_char(fixture.kickoff_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'minutes', fixture.minutes,
      'provisionalStartTime', fixture.provisional_start_time,
      'started', fixture.started,
      'teamA', fixture.team_a_id,
      'teamAScore', fixture.team_a_score,
      'teamH', fixture.team_h_id,
      'teamHScore', fixture.team_h_score,
      'stats', fixture.stats,
      'teamHDifficulty', fixture.team_h_difficulty,
      'teamADifficulty', fixture.team_a_difficulty,
      'pulseId', fixture.pulse_id,
      'createdAt', NULL,
      'updatedAt', NULL
    ) ORDER BY fixture.fixture_id
  ) AS payload
  FROM fpl.fixtures fixture
  WHERE fixture.season_id = 2026
    AND fixture.event_id = 1
), payloads AS (
  SELECT 'eventLive'::text AS item_name, event_lives.payload, 224 AS item_count
  FROM event_lives
  UNION ALL
  SELECT 'fixtures'::text AS item_name, fixtures.payload, jsonb_array_length(fixtures.payload)
  FROM fixtures
)
INSERT INTO graphql_live_items (item_name, payload, item_count, canonical, payload_bytes, checksum)
SELECT
  item_name,
  payload,
  item_count,
  pg_temp.graphql_canonical_json(payload),
  octet_length(convert_to(pg_temp.graphql_canonical_json(payload), 'UTF8')),
  encode(sha256(convert_to(pg_temp.graphql_canonical_json(payload), 'UTF8')), 'hex')
FROM payloads;

INSERT INTO competition.live_points_publication_checkpoints (
  season_id,
  event_id,
  publication_id,
  generation,
  state,
  source_checked_at,
  published_at,
  checkpointed_at,
  expected_next_check_at,
  revisions,
  event_live,
  fixtures,
  event_live_bytes,
  fixtures_bytes,
  event_live_sha256,
  fixtures_sha256,
  event_live_count,
  fixtures_count
)
SELECT
  2026,
  1,
  identity.publication_id::text,
  identity.generation,
  'FINALIZED',
  clock.checked_at,
  clock.checked_at,
  clock.checked_at,
  NULL,
  jsonb_build_object(
    'lifecycle', jsonb_build_object(
      'revision', encode(sha256(convert_to('FINALIZED', 'UTF8')), 'hex'),
      'contentUpdatedAt', to_char(clock.checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'fixtureIdentity', jsonb_build_object(
      'revision', fixture_item.checksum,
      'contentUpdatedAt', to_char(clock.checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'scoreCore', jsonb_build_object(
      'revision', event_item.checksum,
      'contentUpdatedAt', to_char(clock.checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'displayStats', jsonb_build_object(
      'revision', event_item.checksum,
      'contentUpdatedAt', to_char(clock.checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'explain', jsonb_build_object(
      'revision', event_item.checksum,
      'contentUpdatedAt', to_char(clock.checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'rules', jsonb_build_object(
      'revision', encode(sha256(convert_to('live-points-v2-rules-1', 'UTF8')), 'hex'),
      'contentUpdatedAt', to_char(clock.checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
  ),
  event_item.payload,
  fixture_item.payload,
  event_item.payload_bytes,
  fixture_item.payload_bytes,
  event_item.checksum,
  fixture_item.checksum,
  event_item.item_count,
  fixture_item.item_count
FROM graphql_live_identity identity
CROSS JOIN graphql_live_clock clock
JOIN graphql_live_items event_item ON event_item.item_name = 'eventLive'
JOIN graphql_live_items fixture_item ON fixture_item.item_name = 'fixtures'
ON CONFLICT (season_id, event_id) DO UPDATE
SET
  publication_id = EXCLUDED.publication_id,
  generation = EXCLUDED.generation,
  state = EXCLUDED.state,
  source_checked_at = EXCLUDED.source_checked_at,
  published_at = EXCLUDED.published_at,
  checkpointed_at = EXCLUDED.checkpointed_at,
  expected_next_check_at = EXCLUDED.expected_next_check_at,
  revisions = EXCLUDED.revisions,
  event_live = EXCLUDED.event_live,
  fixtures = EXCLUDED.fixtures,
  event_live_bytes = EXCLUDED.event_live_bytes,
  fixtures_bytes = EXCLUDED.fixtures_bytes,
  event_live_sha256 = EXCLUDED.event_live_sha256,
  fixtures_sha256 = EXCLUDED.fixtures_sha256,
  event_live_count = EXCLUDED.event_live_count,
  fixtures_count = EXCLUDED.fixtures_count;

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM competition.live_points_publication_checkpoints
    WHERE season_id = 2026
      AND event_id = 1
      AND state = 'FINALIZED'
  ) <> 1
    OR (
      SELECT publication_id
      FROM competition.live_points_publication_checkpoints
      WHERE season_id = 2026 AND event_id = 1
    ) <> (SELECT publication_id::text FROM graphql_live_identity)
    OR (
      SELECT event_live_count
      FROM competition.live_points_publication_checkpoints
      WHERE season_id = 2026 AND event_id = 1
    ) <> 224
    OR (
      SELECT event_live_sha256
      FROM competition.live_points_publication_checkpoints
      WHERE season_id = 2026 AND event_id = 1
    ) <> (SELECT checksum FROM graphql_live_items WHERE item_name = 'eventLive') THEN
    RAISE EXCEPTION 'expected complete event-1 Live V2 checkpoint authority fixture';
  END IF;
END
$$;

INSERT INTO ops.live_lifecycle_status (
  season_id,
  event_id,
  state,
  observed_at,
  last_changed_at,
  next_refresh_at,
  generation,
  publication_id,
  source_checked_at,
  updated_at
) VALUES (
  2026,
  1,
  'FINALIZED',
  (SELECT checked_at FROM graphql_live_clock),
  (SELECT checked_at FROM graphql_live_clock),
  NULL,
  (SELECT generation FROM graphql_live_identity),
  (SELECT publication_id FROM graphql_live_identity),
  (SELECT checked_at FROM graphql_live_clock),
  (SELECT checked_at FROM graphql_live_clock)
)
ON CONFLICT (season_id, event_id) DO UPDATE
SET
  state = EXCLUDED.state,
  observed_at = EXCLUDED.observed_at,
  last_changed_at = EXCLUDED.last_changed_at,
  next_refresh_at = EXCLUDED.next_refresh_at,
  generation = EXCLUDED.generation,
  publication_id = EXCLUDED.publication_id,
  source_checked_at = EXCLUDED.source_checked_at,
  updated_at = EXCLUDED.updated_at;

END;
$graphql_live$;

INSERT INTO competition.entries (
  season_id,
  entry_id,
  entry_name,
  player_name,
  started_event,
  last_event_id,
  past_seasons_checked_at,
  past_seasons_count,
  transfers_synced_through_event_id,
  updated_at
) VALUES (
  2026,
  1,
  'GraphQL contract sentinel',
  'GraphQL contract sentinel',
  2,
  0,
  '2026-08-10T00:00:00.000Z',
  0,
  2,
  '2026-08-10T00:00:00.000Z'
)
ON CONFLICT (season_id, entry_id) DO UPDATE
SET
  entry_name = EXCLUDED.entry_name,
  player_name = EXCLUDED.player_name,
  started_event = EXCLUDED.started_event,
  last_event_id = EXCLUDED.last_event_id,
  past_seasons_checked_at = EXCLUDED.past_seasons_checked_at,
  past_seasons_count = EXCLUDED.past_seasons_count,
  transfers_synced_through_event_id = EXCLUDED.transfers_synced_through_event_id,
  updated_at = EXCLUDED.updated_at;

-- Entry identity is part of the authenticated EMPTY snapshot. Clear any
-- retained season totals and previous-name state so the payload cannot claim
-- nulls while the producer would copy stale values from competition.entries.
UPDATE competition.entries
SET region = NULL,
    overall_points = NULL,
    overall_rank = NULL,
    bank = NULL,
    team_value = NULL,
    total_transfers = NULL,
    last_entry_name = NULL,
    last_overall_points = NULL,
    last_overall_rank = NULL,
    last_team_value = NULL,
    last_bank = NULL,
    used_entry_names = '{}'::text[],
    snapshot_synced_through_event_id = NULL,
    transfers_source_checked_at = NULL,
    updated_at = '2026-08-10T00:00:00.000Z'::timestamptz
WHERE season_id = 2026
  AND entry_id = 1;

-- The fixture is rerunnable: remove source facts that could otherwise make a
-- zero-history late entrant look like it has a completed gameweek or transfer
-- stream. The publication readers must observe the same empty source the
-- producer would capture for an entry joining at event 2.
DELETE FROM competition.entry_event_picks
WHERE season_id = 2026 AND entry_id = 1 AND event_id IN (1, 2);

DELETE FROM competition.entry_event_pick_heads
WHERE season_id = 2026 AND entry_id = 1 AND event_id IN (1, 2);

DELETE FROM competition.entry_event_pick_repairs
WHERE season_id = 2026 AND entry_id = 1 AND event_id IN (1, 2);

DELETE FROM competition.entry_event_transfers
WHERE season_id = 2026 AND entry_id = 1 AND event_id IN (1, 2);

DELETE FROM competition.entry_event_results
WHERE season_id = 2026 AND entry_id = 1 AND event_id IN (1, 2);

DELETE FROM competition.entry_past_seasons
WHERE entry_season_id = 2026 AND entry_id = 1;

DO $$
BEGIN
  IF (SELECT count(*) FROM fpl.events WHERE season_id = 2026) <> 38 THEN
    RAISE EXCEPTION 'GraphQL contract fixture requires exactly 38 events in season 2026';
  END IF;
  IF (SELECT count(*) FROM competition.entries WHERE season_id = 2026) <> 1 THEN
    RAISE EXCEPTION 'GraphQL contract fixture requires exactly one entry in season 2026';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM competition.entries
    WHERE season_id = 2026 AND entry_id <> 1
  ) THEN
    RAISE EXCEPTION 'GraphQL contract fixture cannot publish with unrelated season entries';
  END IF;
END
$$;

INSERT INTO competition.tournaments (
  tournament_id,
  season_id,
  name,
  creator,
  admin_entry_id,
  league_id,
  league_type,
  total_team_num,
  tournament_mode,
  group_mode,
  group_auto_averages,
  state,
  setup_status,
  setup_phase,
  setup_finished_at,
  standings_ready_at
) VALUES (
  2147483000,
  2026,
  'GraphQL contract tournament',
  'GraphQL contract sentinel',
  1,
  1,
  'classic',
  1,
  'normal',
  'no_group',
  FALSE,
  'active',
  'ready',
  'ready',
  '2026-08-10T00:00:02.000Z',
  '2026-08-10T00:00:02.000Z'
)
ON CONFLICT (season_id, tournament_id) DO UPDATE
SET
  name = EXCLUDED.name,
  creator = EXCLUDED.creator,
  admin_entry_id = EXCLUDED.admin_entry_id,
  league_id = EXCLUDED.league_id,
  league_type = EXCLUDED.league_type,
  total_team_num = EXCLUDED.total_team_num,
  tournament_mode = EXCLUDED.tournament_mode,
  group_mode = EXCLUDED.group_mode,
  group_auto_averages = EXCLUDED.group_auto_averages,
  state = EXCLUDED.state,
  setup_status = EXCLUDED.setup_status,
  setup_phase = EXCLUDED.setup_phase,
  setup_finished_at = EXCLUDED.setup_finished_at,
  standings_ready_at = EXCLUDED.standings_ready_at,
  updated_at = EXCLUDED.updated_at;

INSERT INTO competition.tournaments (
  tournament_id,
  season_id,
  name,
  creator,
  admin_entry_id,
  league_id,
  league_type,
  total_team_num,
  tournament_mode,
  group_mode,
  group_auto_averages,
  state,
  setup_status,
  setup_phase,
  setup_finished_at,
  standings_ready_at,
  updated_at
) VALUES (
  2147483001,
  2026,
  'GraphQL contract league-only tournament',
  'GraphQL contract sentinel',
  1,
  2,
  'classic',
  1,
  'normal',
  'no_group',
  FALSE,
  'active',
  'ready',
  'ready',
  '2026-08-10T00:00:02.000Z',
  '2026-08-10T00:00:02.000Z',
  '2026-08-10T00:00:02.000Z'
)
ON CONFLICT (season_id, tournament_id) DO UPDATE
SET
  name = EXCLUDED.name,
  creator = EXCLUDED.creator,
  admin_entry_id = EXCLUDED.admin_entry_id,
  league_id = EXCLUDED.league_id,
  league_type = EXCLUDED.league_type,
  total_team_num = EXCLUDED.total_team_num,
  tournament_mode = EXCLUDED.tournament_mode,
  group_mode = EXCLUDED.group_mode,
  group_auto_averages = EXCLUDED.group_auto_averages,
  state = EXCLUDED.state,
  setup_status = EXCLUDED.setup_status,
  setup_phase = EXCLUDED.setup_phase,
  setup_finished_at = EXCLUDED.setup_finished_at,
  standings_ready_at = EXCLUDED.standings_ready_at,
  updated_at = EXCLUDED.updated_at;

DO $$
BEGIN
  IF (SELECT count(*) FROM competition.tournaments WHERE season_id = 2026) <> 2 THEN
    RAISE EXCEPTION 'GraphQL contract fixture requires exactly two tournaments in season 2026';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM competition.tournaments
    WHERE season_id = 2026
      AND tournament_id NOT IN (2147483000, 2147483001)
  ) THEN
    RAISE EXCEPTION 'GraphQL contract fixture cannot publish with unrelated season tournaments';
  END IF;
END
$$;

INSERT INTO competition.tournament_entries (
  tournament_id,
  season_id,
  league_id,
  entry_id
) VALUES (
  2147483000,
  2026,
  1,
  1
), (
  2147483001,
  2026,
  2,
  1
)
ON CONFLICT (tournament_id, entry_id) DO UPDATE
SET season_id = EXCLUDED.season_id,
    league_id = EXCLUDED.league_id;

-- Replace the complete source-league snapshot before restoring the one
-- intentionally visible league row. An upsert alone would retain unrelated
-- rows from a previous fixture run.
DELETE FROM competition.entry_leagues
WHERE season_id = 2026 AND entry_id = 1;

-- source_entry_league_id is a generated global identity. Let PostgreSQL
-- allocate it so this fixture cannot collide with a source row from another
-- season or with an identity explicitly reserved by an older run.
INSERT INTO competition.entry_leagues (
  season_id,
  entry_id,
  league_id,
  league_type,
  league_name,
  started_event,
  entry_rank,
  entry_last_rank,
  updated_at
) VALUES (
  2026,
  1,
  2,
  'classic',
  'GraphQL contract league-only membership',
  1,
  1,
  1,
  '2026-08-10T00:00:00.000Z'
)
ON CONFLICT (season_id, entry_id, league_id, league_type) DO UPDATE
SET
  league_name = EXCLUDED.league_name,
  started_event = EXCLUDED.started_event,
  entry_rank = EXCLUDED.entry_rank,
  entry_last_rank = EXCLUDED.entry_last_rank,
  updated_at = EXCLUDED.updated_at;

INSERT INTO fpl.teams (
  season_id,
  team_id,
  code,
  name,
  short_name,
  updated_at
) VALUES (
  2026,
  1,
  2601,
  'GraphQL Contract Team',
  'GCT',
  '2026-08-10T00:00:00.000Z'
)
ON CONFLICT (season_id, team_id) DO UPDATE
SET
  code = EXCLUDED.code,
  name = EXCLUDED.name,
  short_name = EXCLUDED.short_name,
  updated_at = EXCLUDED.updated_at;

UPDATE fpl.teams
SET
  strength = NULL,
  position = 1,
  points = 0,
  played = 0,
  win = 0,
  draw = 0,
  loss = 0,
  form = NULL,
  strength_overall_home = 1000,
  strength_overall_away = 1000,
  strength_attack_home = 1000,
  strength_attack_away = 1000,
  strength_defence_home = 1000,
  strength_defence_away = 1000,
  team_division = NULL,
  unavailable = FALSE,
  pulse_id = 2601,
  updated_at = '2026-08-10T00:00:00.000Z'
WHERE season_id = 2026 AND team_id = 1;

INSERT INTO fpl.teams (
  season_id,
  team_id,
  code,
  name,
  short_name,
  strength,
  position,
  points,
  played,
  win,
  draw,
  loss,
  form,
  strength_overall_home,
  strength_overall_away,
  strength_attack_home,
  strength_attack_away,
  strength_defence_home,
  strength_defence_away,
  pulse_id,
  updated_at
)
SELECT
  2026,
  team_id,
  2600 + team_id,
  format('GraphQL Contract Team %s', team_id),
  format('GC%s', team_id),
  NULL,
  team_id,
  0,
  0,
  0,
  0,
  0,
  NULL,
  1000,
  1000,
  1000,
  1000,
  1000,
  1000,
  2600 + team_id,
  '2026-08-10T00:00:00.000Z'::timestamptz
FROM generate_series(2, 20) AS team_id
ON CONFLICT (season_id, team_id) DO UPDATE
SET
  code = EXCLUDED.code,
  name = EXCLUDED.name,
  short_name = EXCLUDED.short_name,
  strength = EXCLUDED.strength,
  position = EXCLUDED.position,
  points = EXCLUDED.points,
  played = EXCLUDED.played,
  win = EXCLUDED.win,
  draw = EXCLUDED.draw,
  loss = EXCLUDED.loss,
  form = EXCLUDED.form,
  strength_overall_home = EXCLUDED.strength_overall_home,
  strength_overall_away = EXCLUDED.strength_overall_away,
  strength_attack_home = EXCLUDED.strength_attack_home,
  strength_attack_away = EXCLUDED.strength_attack_away,
  strength_defence_home = EXCLUDED.strength_defence_home,
  strength_defence_away = EXCLUDED.strength_defence_away,
  pulse_id = EXCLUDED.pulse_id,
  updated_at = EXCLUDED.updated_at;

-- The Core team transformer always publishes these fields. Clear retained
-- values for every seeded team before deriving the authenticated item proof.
UPDATE fpl.teams
SET team_division = NULL,
    unavailable = FALSE,
    updated_at = '2026-08-10T00:00:00.000Z'::timestamptz
WHERE season_id = 2026;

INSERT INTO fpl.players (
  season_id,
  element_id,
  code,
  element_type,
  team_id,
  price,
  start_price,
  first_name,
  second_name,
  web_name,
  updated_at
)
SELECT
  2026,
  player_id,
  26000 + player_id,
  CASE
    WHEN player_id = 1 THEN 1
    WHEN player_id BETWEEN 2 AND 6 THEN 2
    WHEN player_id BETWEEN 7 AND 12 THEN 3
    ELSE 4
  END,
  1,
  50,
  50,
  'GraphQL',
  format('Contract Player %s', player_id),
  format('GC%s', player_id),
  '2026-08-10T00:00:00.000Z'
FROM generate_series(1, 15) AS player_id
ON CONFLICT (season_id, element_id) DO UPDATE
SET
  code = EXCLUDED.code,
  element_type = EXCLUDED.element_type,
  team_id = EXCLUDED.team_id,
  price = EXCLUDED.price,
  start_price = EXCLUDED.start_price,
  first_name = EXCLUDED.first_name,
  second_name = EXCLUDED.second_name,
  web_name = EXCLUDED.web_name,
  is_active = TRUE,
  updated_at = EXCLUDED.updated_at;

INSERT INTO fpl.players (
  season_id,
  element_id,
  code,
  element_type,
  team_id,
  price,
  start_price,
  first_name,
  second_name,
  web_name,
  updated_at
)
SELECT
  2026,
  player_id,
  26000 + player_id,
  ((player_id - 1) % 4) + 1,
  ((player_id - 16) / 11) + 2,
  50,
  50,
  'GraphQL',
  format('Contract Player %s', player_id),
  format('GC%s', player_id),
  '2026-08-10T00:00:00.000Z'::timestamptz
FROM generate_series(16, 224) AS player_id
ON CONFLICT (season_id, element_id) DO UPDATE
SET
  code = EXCLUDED.code,
  element_type = EXCLUDED.element_type,
  team_id = EXCLUDED.team_id,
  price = EXCLUDED.price,
  start_price = EXCLUDED.start_price,
  first_name = EXCLUDED.first_name,
  second_name = EXCLUDED.second_name,
  web_name = EXCLUDED.web_name,
  is_active = TRUE,
  updated_at = EXCLUDED.updated_at;

-- The proof below is generated from the resulting rows. Reset all fields that
-- are part of the Core player item so a rerun over an already-synced season
-- cannot retain a different total_points value.
UPDATE fpl.players
SET total_points = 0,
    is_active = TRUE,
    updated_at = '2026-08-10T00:00:00.000Z'::timestamptz
WHERE season_id = 2026;

-- Keep one immutable value-seeded market observation visible to the
-- GraphQL reader role.  The market contract executes the production query
-- (rather than accepting EXPLAIN alone), so the fixture must include a
-- complete row with valid player/team/event lineage and decoder fields.
-- The source-value identity is unique within a season. Reused databases may
-- already contain a different row for this reserved identity, so clear it
-- before inserting the deterministic contract row.
DELETE FROM fpl.player_market_snapshots
WHERE season_id = 2026 AND source_value_id = 26001;

INSERT INTO fpl.player_market_snapshots (
  season_id,
  snapshot_date,
  element_id,
  snapshot_source,
  source_snapshot_id,
  source_value_id,
  source_event_id,
  captured_at,
  player_code,
  web_name,
  first_name,
  second_name,
  team_id,
  team_name,
  team_short_name,
  element_type,
  position,
  price,
  selected_by_percent,
  transfers_in,
  transfers_out,
  transfers_in_event,
  transfers_out_event,
  status,
  news,
  news_added,
  chance_of_playing_this_round,
  chance_of_playing_next_round,
  created_at,
  updated_at
)
VALUES (
  2026,
  '2025-08-28',
  1,
  'value_seed',
  NULL,
  26001,
  1,
  '2025-08-28T00:00:00.000Z',
  26001,
  'GC1',
  'GraphQL',
  'Contract Player 1',
  1,
  'GraphQL Contract Team',
  'GCT',
  1,
  'GKP',
  50,
  1,
  0,
  0,
  0,
  0,
  'a',
  '',
  NULL,
  100,
  100,
  '2025-08-28T00:00:00.000Z',
  '2025-08-28T00:00:00.000Z'
)
ON CONFLICT (season_id, snapshot_date, element_id) DO UPDATE
SET
  snapshot_source = EXCLUDED.snapshot_source,
  source_snapshot_id = EXCLUDED.source_snapshot_id,
  source_value_id = EXCLUDED.source_value_id,
  source_event_id = EXCLUDED.source_event_id,
  captured_at = EXCLUDED.captured_at,
  player_code = EXCLUDED.player_code,
  web_name = EXCLUDED.web_name,
  first_name = EXCLUDED.first_name,
  second_name = EXCLUDED.second_name,
  team_id = EXCLUDED.team_id,
  team_name = EXCLUDED.team_name,
  team_short_name = EXCLUDED.team_short_name,
  element_type = EXCLUDED.element_type,
  position = EXCLUDED.position,
  price = EXCLUDED.price,
  selected_by_percent = EXCLUDED.selected_by_percent,
  transfers_in = EXCLUDED.transfers_in,
  transfers_out = EXCLUDED.transfers_out,
  transfers_in_event = EXCLUDED.transfers_in_event,
  transfers_out_event = EXCLUDED.transfers_out_event,
  status = EXCLUDED.status,
  news = EXCLUDED.news,
  news_added = EXCLUDED.news_added,
  chance_of_playing_this_round = EXCLUDED.chance_of_playing_this_round,
  chance_of_playing_next_round = EXCLUDED.chance_of_playing_next_round,
  updated_at = EXCLUDED.updated_at;

-- Player picker and player-value contracts pin the newer market observation;
-- retain the historical 2025-08-28 observation above for the seven-day market
-- window and publish a second immutable observation for the newer readers.
DELETE FROM fpl.player_market_snapshots
WHERE season_id = 2026 AND source_value_id = 26002;

INSERT INTO fpl.player_market_snapshots (
  season_id,
  snapshot_date,
  element_id,
  snapshot_source,
  source_snapshot_id,
  source_value_id,
  source_event_id,
  captured_at,
  player_code,
  web_name,
  first_name,
  second_name,
  team_id,
  team_name,
  team_short_name,
  element_type,
  position,
  price,
  selected_by_percent,
  transfers_in,
  transfers_out,
  transfers_in_event,
  transfers_out_event,
  status,
  news,
  news_added,
  chance_of_playing_this_round,
  chance_of_playing_next_round,
  created_at,
  updated_at
)
SELECT
  market.season_id,
  '2026-08-10'::date,
  market.element_id,
  market.snapshot_source,
  market.source_snapshot_id,
  26002,
  market.source_event_id,
  '2026-08-10T00:00:00.000Z'::timestamptz,
  market.player_code,
  market.web_name,
  market.first_name,
  market.second_name,
  market.team_id,
  market.team_name,
  market.team_short_name,
  market.element_type,
  market.position,
  market.price,
  market.selected_by_percent,
  market.transfers_in,
  market.transfers_out,
  market.transfers_in_event,
  market.transfers_out_event,
  market.status,
  market.news,
  market.news_added,
  market.chance_of_playing_this_round,
  market.chance_of_playing_next_round,
  '2026-08-10T00:00:00.000Z'::timestamptz,
  '2026-08-10T00:00:00.000Z'::timestamptz
FROM fpl.player_market_snapshots market
WHERE market.season_id = 2026
  AND market.source_value_id = 26001
ON CONFLICT (season_id, snapshot_date, element_id) DO UPDATE
SET
  snapshot_source = EXCLUDED.snapshot_source,
  source_snapshot_id = EXCLUDED.source_snapshot_id,
  source_value_id = EXCLUDED.source_value_id,
  source_event_id = EXCLUDED.source_event_id,
  captured_at = EXCLUDED.captured_at,
  player_code = EXCLUDED.player_code,
  web_name = EXCLUDED.web_name,
  first_name = EXCLUDED.first_name,
  second_name = EXCLUDED.second_name,
  team_id = EXCLUDED.team_id,
  team_name = EXCLUDED.team_name,
  team_short_name = EXCLUDED.team_short_name,
  element_type = EXCLUDED.element_type,
  position = EXCLUDED.position,
  price = EXCLUDED.price,
  selected_by_percent = EXCLUDED.selected_by_percent,
  transfers_in = EXCLUDED.transfers_in,
  transfers_out = EXCLUDED.transfers_out,
  transfers_in_event = EXCLUDED.transfers_in_event,
  transfers_out_event = EXCLUDED.transfers_out_event,
  status = EXCLUDED.status,
  news = EXCLUDED.news,
  news_added = EXCLUDED.news_added,
  chance_of_playing_this_round = EXCLUDED.chance_of_playing_this_round,
  chance_of_playing_next_round = EXCLUDED.chance_of_playing_next_round,
  updated_at = EXCLUDED.updated_at;

INSERT INTO fpl.phases (
  season_id,
  phase_id,
  name,
  start_event,
  stop_event,
  highest_score,
  updated_at
)
VALUES (
  2026,
  1,
  'Overall',
  1,
  38,
  NULL,
  '2026-08-10T00:00:00.000Z'::timestamptz
)
ON CONFLICT (season_id, phase_id) DO UPDATE
SET
  name = EXCLUDED.name,
  start_event = EXCLUDED.start_event,
  stop_event = EXCLUDED.stop_event,
  highest_score = EXCLUDED.highest_score,
  updated_at = EXCLUDED.updated_at;

WITH pairings AS (
  SELECT
    row_number() OVER (ORDER BY home_id, away_id, home_id) AS fixture_id,
    home_id AS team_h_id,
    away_id AS team_a_id
  FROM generate_series(1, 20) AS home_id
  CROSS JOIN generate_series(1, 20) AS away_id
  WHERE home_id < away_id
  UNION ALL
  SELECT
    row_number() OVER (ORDER BY home_id, away_id, home_id) + 190 AS fixture_id,
    away_id AS team_h_id,
    home_id AS team_a_id
  FROM generate_series(1, 20) AS home_id
  CROSS JOIN generate_series(1, 20) AS away_id
  WHERE home_id < away_id
)
INSERT INTO fpl.fixtures (
  season_id,
  fixture_id,
  code,
  event_id,
  kickoff_time,
  provisional_start_time,
  started,
  finished,
  finished_provisional,
  minutes,
  team_h_id,
  team_a_id,
  team_h_score,
  team_a_score,
  team_h_difficulty,
  team_a_difficulty,
  stats,
  pulse_id,
  updated_at
)
SELECT
  2026,
  fixture_id::integer,
  50000 + fixture_id::integer,
  ((fixture_id - 1) % 38 + 1)::integer,
  '2026-08-01T11:00:00.000Z'::timestamptz
    + (((fixture_id - 1) % 38) * interval '7 days')
    + (((fixture_id - 1) / 38) * interval '2 hours'),
  FALSE,
  (((fixture_id - 1) % 38 + 1) = 1),
  (((fixture_id - 1) % 38 + 1) = 1),
  FALSE,
  CASE WHEN ((fixture_id - 1) % 38 + 1) = 1 THEN 90 ELSE 0 END,
  team_h_id,
  team_a_id,
  CASE WHEN ((fixture_id - 1) % 38 + 1) = 1 THEN 0 ELSE NULL END,
  CASE WHEN ((fixture_id - 1) % 38 + 1) = 1 THEN 0 ELSE NULL END,
  NULL,
  NULL,
  '[]'::jsonb,
  50000 + fixture_id::integer,
  '2026-08-10T00:00:00.000Z'::timestamptz
FROM pairings
ON CONFLICT (season_id, fixture_id) DO UPDATE
SET
  code = EXCLUDED.code,
  event_id = EXCLUDED.event_id,
  kickoff_time = EXCLUDED.kickoff_time,
  provisional_start_time = EXCLUDED.provisional_start_time,
  started = EXCLUDED.started,
  finished = EXCLUDED.finished,
  finished_provisional = EXCLUDED.finished_provisional,
  minutes = EXCLUDED.minutes,
  team_h_id = EXCLUDED.team_h_id,
  team_a_id = EXCLUDED.team_a_id,
  team_h_score = EXCLUDED.team_h_score,
  team_a_score = EXCLUDED.team_a_score,
  team_h_difficulty = EXCLUDED.team_h_difficulty,
  team_a_difficulty = EXCLUDED.team_a_difficulty,
  stats = EXCLUDED.stats,
  pulse_id = EXCLUDED.pulse_id,
  updated_at = EXCLUDED.updated_at;

DO $$
BEGIN
  IF (SELECT count(*) FROM fpl.events WHERE season_id = 2026) <> 38
    OR (SELECT count(*) FROM fpl.teams WHERE season_id = 2026) <> 20
    OR (SELECT count(*) FROM fpl.players WHERE season_id = 2026) <> 224
    OR (SELECT count(*) FROM fpl.phases WHERE season_id = 2026) <> 1
    OR (SELECT count(*) FROM fpl.fixtures WHERE season_id = 2026) <> 380 THEN
    RAISE EXCEPTION 'GraphQL contract fixture requires complete Core identity arrays';
  END IF;
END
$$;

-- Persist the same fixture-grain evidence that the producer derives from the
-- event-live explain payload before publishing Live. The Gameweek fallback
-- reads this row independently, so keeping it in the publication's source
-- scope prevents the two read paths from advertising different facts.
DELETE FROM fpl.player_fixture_stats
WHERE season_id = 2026
  AND event_id = 1
  AND fixture_id = 1;

INSERT INTO fpl.player_fixture_stats (
  season_id,
  fixture_id,
  element_id,
  event_id,
  fixture_code,
  player_code,
  team_id,
  team_code,
  element_type,
  minutes,
  starts,
  goals,
  assists,
  own_goals,
  yellow_cards,
  red_cards,
  source_hash,
  created_at,
  updated_at
)
VALUES (
  2026,
  1,
  1,
  1,
  50001,
  26001,
  1,
  2601,
  1,
  90,
  1,
  0,
  0,
  0,
  0,
  0,
  'graphql-contract-player-fixture-1',
  '2026-08-10T00:00:00.000Z'::timestamptz,
  '2026-08-10T00:00:00.000Z'::timestamptz
);

-- Run the deferred Live aggregation only after all producer identities exist.
SELECT pg_temp.seed_graphql_live_authority();

-- Rebuild the complete Player State season scope through the same canonical
-- summary and projection functions used by the producer.  A single sentinel
-- row is not a valid projection: the refresh rejects any season whose summary
-- row count does not exactly match its FPL player universe.
DO $$
BEGIN
  PERFORM reporting.refresh_player_season_summaries(2026::smallint);
  PERFORM reporting.refresh_player_state_season(2026::smallint);
END
$$;

-- Restore shared bridge rows only after the season-local projection has been
-- rebuilt without them. The captured evidence remains durable, including its
-- 2627 confirmation, while the refresh still publishes the fresh-install
-- Player State status for this fixture.
INSERT INTO bridge.entity_links (
  link_id,
  entity_type,
  left_provider,
  left_entity_id,
  right_provider,
  right_entity_id,
  status,
  method,
  rule_id,
  evidence,
  first_seen_season,
  last_seen_season,
  reviewed_by,
  reviewed_at,
  created_at,
  updated_at
)
SELECT
  link.link_id,
  link.entity_type,
  link.left_provider,
  link.left_entity_id,
  link.right_provider,
  link.right_entity_id,
  link.status,
  link.method,
  link.rule_id,
  link.evidence,
  link.first_seen_season,
  link.last_seen_season,
  link.reviewed_by,
  link.reviewed_at,
  link.created_at,
  link.updated_at
FROM pg_temp.graphql_shared_player_links link
ON CONFLICT (link_id) DO UPDATE
SET evidence = EXCLUDED.evidence,
    updated_at = EXCLUDED.updated_at;

DO $$
BEGIN
  IF (
    SELECT count(*) FROM reporting.player_season_summary_rows WHERE season_id = 2026
  ) <> (
    SELECT count(*) FROM fpl.players WHERE season_id = 2026
  ) OR (
    SELECT count(*) FROM reporting.player_state_season_rows WHERE season_id = 2026
  ) <> (
    SELECT count(*) FROM fpl.players WHERE season_id = 2026
  ) THEN
    RAISE EXCEPTION 'GraphQL contract fixture requires complete Player State season scope';
  END IF;
END
$$;

-- Keep a complete pinned event-stat snapshot visible to the GraphQL player
-- picker. The supported publisher rejects any set that does not exactly match
-- the active Core player universe. Element 1 remains the contract sentinel for
-- the requested event and publication revision; all other rows are explicit
-- zero-valued event facts rather than silent fallback data.
DELETE FROM fpl.player_event_snapshots
WHERE season_id = 2026 AND event_id = 1;

INSERT INTO fpl.player_event_snapshot_publications (
  season_id,
  event_id,
  revision,
  source_checked_at,
  published_at,
  row_count,
  expected_row_count,
  content_sha256,
  baseline_verified_at
)
SELECT
  2026,
  1,
  GREATEST(
    COALESCE(
      (
        SELECT publication.revision + 1
        FROM fpl.player_event_snapshot_publications publication
        WHERE publication.season_id = 2026 AND publication.event_id = 1
      ),
      1::bigint
    ),
    nextval('fpl.player_event_snapshot_publication_revision_seq'::regclass)
  ),
  '2026-08-10T00:00:00.000Z'::timestamptz,
  '2026-08-10T00:00:00.000Z'::timestamptz,
  224,
  224,
  repeat('a', 64),
  '2026-08-10T00:00:00.000Z'::timestamptz
ON CONFLICT (season_id, event_id) DO UPDATE
SET
  revision = EXCLUDED.revision,
  source_checked_at = EXCLUDED.source_checked_at,
  published_at = EXCLUDED.published_at,
  row_count = EXCLUDED.row_count,
  expected_row_count = EXCLUDED.expected_row_count,
  content_sha256 = EXCLUDED.content_sha256,
  baseline_verified_at = EXCLUDED.baseline_verified_at,
  updated_at = EXCLUDED.updated_at;

-- The fixture chooses the greater of the existing header successor and the
-- producer sequence. Keep that sequence at or above the chosen revision so a
-- subsequent replaceBatch cannot allocate an older event-snapshot revision.
SELECT setval(
  'fpl.player_event_snapshot_publication_revision_seq'::regclass,
  GREATEST(
    COALESCE((
      SELECT max(revision)
      FROM fpl.player_event_snapshot_publications
      WHERE season_id = 2026 AND event_id = 1
    ), 0),
    (SELECT last_value FROM fpl.player_event_snapshot_publication_revision_seq),
    1
  ),
  TRUE
);

INSERT INTO fpl.player_event_snapshots (
  season_id,
  event_id,
  element_id,
  element_type,
  total_points,
  form,
  minutes,
  selected_by_percent,
  created_at,
  updated_at
) SELECT
    2026,
    1,
    player.element_id,
    player.element_type,
    CASE WHEN player.element_id = 1 THEN 42 ELSE 0 END,
    CASE WHEN player.element_id = 1 THEN 4.2 ELSE NULL END,
    90,
    CASE WHEN player.element_id = 1 THEN 12.34 ELSE 0 END,
    '2026-08-10T00:00:00.000Z'::timestamptz,
    '2026-08-10T00:00:00.000Z'::timestamptz
  FROM fpl.players player
  WHERE player.season_id = 2026;

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM fpl.player_event_snapshots
    WHERE season_id = 2026 AND event_id = 1
  ) <> 224 OR (
    SELECT row_count
    FROM fpl.player_event_snapshot_publications
    WHERE season_id = 2026 AND event_id = 1
  ) <> 224 OR (
    SELECT expected_row_count
    FROM fpl.player_event_snapshot_publications
    WHERE season_id = 2026 AND event_id = 1
  ) <> 224 THEN
    RAISE EXCEPTION 'GraphQL contract fixture requires a complete event-stat snapshot';
  END IF;
END
$$;

-- The supported publisher hashes the complete producer row shape, in
-- element-id order, before writing the publication header. Reproduce that
-- canonical array here rather than using a placeholder: decimal columns are
-- text in the Drizzle insert model, while integer columns remain JSON numbers.
WITH canonical_rows AS (
  SELECT jsonb_agg(
    jsonb_build_array(
      jsonb_build_array('elementId', snapshot.element_id),
      jsonb_build_array('elementType', snapshot.element_type),
      jsonb_build_array('totalPoints', snapshot.total_points),
      jsonb_build_array('form', snapshot.form::text),
      jsonb_build_array('influence', snapshot.influence::text),
      jsonb_build_array('creativity', snapshot.creativity::text),
      jsonb_build_array('threat', snapshot.threat::text),
      jsonb_build_array('ictIndex', snapshot.ict_index::text),
      jsonb_build_array('expectedGoals', snapshot.expected_goals::text),
      jsonb_build_array('expectedAssists', snapshot.expected_assists::text),
      jsonb_build_array('expectedGoalInvolvements', snapshot.expected_goal_involvements::text),
      jsonb_build_array('expectedGoalsConceded', snapshot.expected_goals_conceded::text),
      jsonb_build_array('minutes', snapshot.minutes),
      jsonb_build_array('goalsScored', snapshot.goals_scored),
      jsonb_build_array('assists', snapshot.assists),
      jsonb_build_array('cleanSheets', snapshot.clean_sheets),
      jsonb_build_array('goalsConceded', snapshot.goals_conceded),
      jsonb_build_array('ownGoals', snapshot.own_goals),
      jsonb_build_array('penaltiesSaved', snapshot.penalties_saved),
      jsonb_build_array('yellowCards', snapshot.yellow_cards),
      jsonb_build_array('redCards', snapshot.red_cards),
      jsonb_build_array('saves', snapshot.saves),
      jsonb_build_array('bonus', snapshot.bonus),
      jsonb_build_array('bps', snapshot.bps),
      jsonb_build_array('starts', snapshot.starts),
      jsonb_build_array('transfersIn', snapshot.transfers_in),
      jsonb_build_array('transfersInEvent', snapshot.transfers_in_event),
      jsonb_build_array('transfersOut', snapshot.transfers_out),
      jsonb_build_array('transfersOutEvent', snapshot.transfers_out_event),
      jsonb_build_array('influenceRank', snapshot.influence_rank),
      jsonb_build_array('influenceRankType', snapshot.influence_rank_type),
      jsonb_build_array('creativityRank', snapshot.creativity_rank),
      jsonb_build_array('creativityRankType', snapshot.creativity_rank_type),
      jsonb_build_array('threatRank', snapshot.threat_rank),
      jsonb_build_array('threatRankType', snapshot.threat_rank_type),
      jsonb_build_array('ictIndexRank', snapshot.ict_index_rank),
      jsonb_build_array('ictIndexRankType', snapshot.ict_index_rank_type),
      jsonb_build_array('selectedByPercent', snapshot.selected_by_percent::text)
      ) ORDER BY snapshot.element_id
    ) AS canonical
  FROM fpl.player_event_snapshots snapshot
  WHERE snapshot.season_id = 2026 AND snapshot.event_id = 1
)
UPDATE fpl.player_event_snapshot_publications publication
SET content_sha256 = encode(
  sha256(
    convert_to(pg_temp.graphql_canonical_json(canonical_rows.canonical), 'UTF8')
  ),
  'hex'
)
FROM canonical_rows
WHERE publication.season_id = 2026 AND publication.event_id = 1;

DO $$
BEGIN
  IF (
    SELECT content_sha256
    FROM fpl.player_event_snapshot_publications
    WHERE season_id = 2026 AND event_id = 1
  ) = repeat('a', 64) THEN
    RAISE EXCEPTION 'GraphQL contract fixture must publish a content hash derived from all snapshot rows';
  END IF;
END
$$;

-- This fixture owns the complete Core publication item set. Remove retained
-- obsolete items before inserting the seven canonical names so an older row
-- cannot leak into the rebuilt manifest or fail the producer completeness
-- check on a rerun.
DELETE FROM ops.dataset_publication_items
WHERE publication_id = (SELECT publication_id FROM graphql_core_identity);

-- Publish the complete modern Core item set from the same deterministic FPL
-- rows used by the PostgreSQL fallback. The contract harness validates the
-- publication proof independently from mutable-row decoding; keeping both
-- representations here prevents a valid fallback from masking an incomplete
-- Redis delivery.
WITH core_items(name, payload) AS (
  SELECT
    'events',
    jsonb_agg(
      jsonb_build_object(
        'id', event.event_id,
        'name', event.name,
        'deadlineTime', CASE
          WHEN event.deadline_time IS NULL THEN NULL
          ELSE to_char(event.deadline_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END,
        'averageEntryScore', event.average_entry_score,
        'finished', event.finished,
        'dataChecked', event.data_checked,
        'dataCheckedAt', NULL,
        'highestScoringEntry', event.highest_scoring_entry,
        'deadlineTimeEpoch', event.deadline_time_epoch,
        'deadlineTimeGameOffset', event.deadline_time_game_offset,
        'highestScore', event.highest_score,
        'isPrevious', event.is_previous,
        'isCurrent', event.is_current,
        'isNext', event.is_next,
        'cupLeagueCreate', event.cup_league_create,
        'h2hKoMatchesCreated', event.h2h_ko_matches_created,
        'chipPlays', event.chip_plays,
        'mostSelected', event.most_selected,
        'mostTransferredIn', event.most_transferred_in,
        'topElement', event.top_element,
        'topElementInfo', event.top_element_info,
        'transfersMade', event.transfers_made,
        'mostCaptained', event.most_captained,
        'mostViceCaptained', event.most_vice_captained,
        'createdAt', NULL,
        'updatedAt', NULL
      )
      ORDER BY event.event_id
    )
  FROM fpl.events event
  WHERE event.season_id = 2026
  UNION ALL
  SELECT
    'teams',
    jsonb_agg(
      jsonb_build_object(
        'id', team.team_id,
        'code', team.code,
        'name', team.name,
        'shortName', team.short_name,
        'strength', team.strength,
        'position', team.position,
        'points', team.points,
        'played', team.played,
        'win', team.win,
        'draw', team.draw,
        'loss', team.loss,
        'form', team.form,
        'strengthOverallHome', team.strength_overall_home,
        'strengthOverallAway', team.strength_overall_away,
        'strengthAttackHome', team.strength_attack_home,
        'strengthAttackAway', team.strength_attack_away,
        'strengthDefenceHome', team.strength_defence_home,
        'strengthDefenceAway', team.strength_defence_away,
        'teamDivision', team.team_division,
        'unavailable', team.unavailable,
        'pulseId', team.pulse_id,
        'createdAt', NULL,
        'updatedAt', NULL
      )
      ORDER BY team.team_id
    )
  FROM fpl.teams team
  WHERE team.season_id = 2026
  UNION ALL
  SELECT
    'players',
    jsonb_agg(
      jsonb_build_object(
        'id', player.element_id,
        'code', player.code,
        'type', player.element_type,
        'teamId', player.team_id,
        'price', player.price,
        'startPrice', player.start_price,
        'firstName', player.first_name,
        'secondName', player.second_name,
        'webName', player.web_name
      )
      ORDER BY player.element_id
    )
  FROM fpl.players player
  WHERE player.season_id = 2026
  UNION ALL
  SELECT
    'phases',
    jsonb_agg(
      jsonb_build_object(
        'id', phase.phase_id,
        'name', phase.name,
        'startEvent', phase.start_event,
        'stopEvent', phase.stop_event,
        'highestScore', phase.highest_score
      )
      ORDER BY phase.phase_id
    )
  FROM fpl.phases phase
  WHERE phase.season_id = 2026
  UNION ALL
  SELECT
    'fixtures',
    jsonb_agg(
      jsonb_build_object(
        'id', fixture.fixture_id,
        'code', fixture.code,
        'event', fixture.event_id,
        'finished', fixture.finished,
        'finishedProvisional', fixture.finished_provisional,
        'kickoffTime', CASE
          WHEN fixture.kickoff_time IS NULL THEN NULL
          ELSE to_char(fixture.kickoff_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END,
        'minutes', fixture.minutes,
        'provisionalStartTime', fixture.provisional_start_time,
        'started', fixture.started,
        'teamH', fixture.team_h_id,
        'teamA', fixture.team_a_id,
        'teamHScore', fixture.team_h_score,
        'teamAScore', fixture.team_a_score,
        'teamHDifficulty', fixture.team_h_difficulty,
        'teamADifficulty', fixture.team_a_difficulty,
        'stats', fixture.stats,
        'pulseId', fixture.pulse_id,
        'createdAt', NULL,
        'updatedAt', NULL
      )
      ORDER BY fixture.fixture_id
    )
  FROM fpl.fixtures fixture
  WHERE fixture.season_id = 2026
  UNION ALL
  SELECT
    'currentEventId',
    to_jsonb((
      SELECT event.event_id
      FROM fpl.events event
      WHERE event.season_id = 2026
        AND event.deadline_time IS NOT NULL
        AND event.deadline_time <= (SELECT checked_at FROM graphql_core_clock)
      ORDER BY event.deadline_time DESC, event.event_id DESC
      LIMIT 1
    ))
  UNION ALL
  SELECT 'selectionRules', 'null'::jsonb
), prepared AS (
  SELECT
    name,
    payload,
    CASE
      WHEN jsonb_typeof(payload) = 'array' THEN jsonb_array_length(payload)
      WHEN jsonb_typeof(payload) = 'object' THEN (
        SELECT count(*)::integer FROM jsonb_object_keys(payload)
      )
      WHEN jsonb_typeof(payload) = 'null' THEN 0
      ELSE CASE WHEN payload IS NULL THEN 0 ELSE 1 END
    END AS item_count
  FROM core_items
)
INSERT INTO ops.dataset_publication_items (
  publication_id,
  item_name,
  payload,
  item_count,
  checksum
)
SELECT
  (SELECT publication_id FROM graphql_core_identity),
  name,
  payload,
  item_count,
  CASE name
    WHEN 'events' THEN 'd309e4d39e75f55e117cee2097042846c60099a0347b1267c43b3fc715494e2b'
    WHEN 'teams' THEN '37122f6a0f10658b23d55229d0e2d2c7be5011d60b0ddd80d7712bdf68d3d269'
    WHEN 'players' THEN 'b5e45d4b9bf0fa41b64e6b33bc83660fb067fed981ad762aa68ac2de28763c6f'
    WHEN 'phases' THEN '89153d5ae5f8600e41017e6379e2bcb20eca2d17bb1f4a0f2c85842dc8092367'
    WHEN 'fixtures' THEN 'b535270fbfae6bd40d7707516f13434004180c2c5bd76986d5429dbe3744e914'
    WHEN 'currentEventId' THEN 'd4735e3a265e16eee03f59718b9b5d03019c07d8b6c51f90da3a666eec13ab35'
    WHEN 'selectionRules' THEN '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b'
  END
FROM prepared
ON CONFLICT (publication_id, item_name) DO UPDATE
SET payload = EXCLUDED.payload,
    item_count = EXCLUDED.item_count,
    checksum = EXCLUDED.checksum;

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM ops.dataset_publication_items
    WHERE publication_id = (SELECT publication_id FROM graphql_core_identity)
  ) <> 7
  OR EXISTS (
    SELECT 1
    FROM ops.dataset_publication_items
    WHERE publication_id = (SELECT publication_id FROM graphql_core_identity)
      AND item_name NOT IN (
        'events', 'teams', 'players', 'phases', 'fixtures', 'currentEventId', 'selectionRules'
      )
  ) THEN
    RAISE EXCEPTION 'GraphQL contract fixture requires exactly the canonical Core item set';
  END IF;
END
$$;

-- Recompute the Core item proof from the final JSONB rows. Core uses the
-- lexicographic canonical JSON form (the same form consumed by the GraphQL
-- publication loader), so hard-coded byte counts cannot survive a rerun after
-- event metadata or fixture timestamps change.
WITH proofs AS (
  SELECT
    item.item_name,
    item.item_count,
    pg_temp.graphql_canonical_json(item.payload) AS canonical
  FROM ops.dataset_publication_items item
  WHERE item.publication_id = (SELECT publication_id FROM graphql_core_identity)
), updated AS (
  UPDATE ops.dataset_publication_items item
  SET checksum = encode(sha256(convert_to(proof.canonical, 'UTF8')), 'hex')
  FROM proofs proof
  WHERE item.publication_id = (SELECT publication_id FROM graphql_core_identity)
    AND item.item_name = proof.item_name
  RETURNING item.item_name, item.item_count, proof.canonical
), manifest_items AS (
  SELECT jsonb_agg(
    jsonb_build_object(
      'name', item_name,
      'key', 'llm:data:fpl:core:2627:' || (SELECT revision::text FROM graphql_core_identity) || ':' || item_name,
      'type', 'string',
      'count', item_count,
      'bytes', octet_length(convert_to(canonical, 'UTF8')),
      'sha256', encode(sha256(convert_to(canonical, 'UTF8')), 'hex')
    ) ORDER BY CASE item_name
      WHEN 'events' THEN 1
      WHEN 'teams' THEN 2
      WHEN 'players' THEN 3
      WHEN 'phases' THEN 4
      WHEN 'fixtures' THEN 5
      WHEN 'currentEventId' THEN 6
      WHEN 'selectionRules' THEN 7
    END
  ) AS items
  FROM updated
)
UPDATE ops.dataset_publications publication
SET manifest = jsonb_set(publication.manifest, '{items}', manifest_items.items, FALSE),
    updated_at = '2026-08-10T00:00:00.000Z'::timestamptz
FROM manifest_items
WHERE publication.publication_id = (SELECT publication_id FROM graphql_core_identity);

-- Queue the exact immutable Core manifest for the shared Data delivery worker.
-- PostgreSQL activation and this durable hand-off are one transaction; Redis is
-- only rebuilt from this receipt and is never treated as the authority.
INSERT INTO ops.data_publication_outbox (
  outbox_id,
  publication_id,
  source_run_id,
  dataset,
  season_id,
  event_id,
  manifest,
  status,
  available_at,
  attempts,
  lease_owner,
  lease_expires_at,
  staged_at,
  db_activated_at,
  redis_activated_at,
  delivered_at,
  last_error,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  publication.publication_id,
  NULL,
  publication.dataset,
  publication.season_id,
  publication.event_id,
  publication.manifest,
  'pending',
  publication.activated_at,
  0,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  publication.activated_at,
  publication.updated_at
FROM ops.dataset_publications publication
WHERE publication.publication_id = (SELECT publication_id FROM graphql_core_identity)
ON CONFLICT (publication_id) DO UPDATE
SET manifest = EXCLUDED.manifest,
    status = 'pending',
    available_at = EXCLUDED.available_at,
    attempts = 0,
    lease_owner = NULL,
    lease_expires_at = NULL,
    staged_at = NULL,
    db_activated_at = NULL,
    redis_activated_at = NULL,
    delivered_at = NULL,
    last_error = NULL,
    updated_at = EXCLUDED.updated_at;

-- Price Change is a projection of the active Core player universe. Build all
-- 224 players and derive every manifest field from the exact payload rows so
-- the fixture remains fresh and proof-correct whenever it is executed.
DROP TABLE IF EXISTS pg_temp.graphql_price_change_clock;
CREATE TEMP TABLE graphql_price_change_clock (
  fetched_at timestamptz NOT NULL,
  stale_at timestamptz NOT NULL,
  hard_expires_at timestamptz NOT NULL,
  deadline timestamptz NOT NULL,
  published_at timestamptz NOT NULL
);

INSERT INTO graphql_price_change_clock
SELECT fetched_at,
       fetched_at + interval '10 minutes',
       fetched_at + interval '1 hour',
       fetched_at + interval '30 minutes',
       date_trunc('second', clock_timestamp())
FROM (
  SELECT date_trunc('second', clock_timestamp() - interval '5 minutes') AS fetched_at
) AS clock;

DROP TABLE IF EXISTS pg_temp.graphql_price_change_items;
CREATE TEMP TABLE graphql_price_change_items (
  item_name text PRIMARY KEY,
  payload jsonb NOT NULL,
  item_count integer NOT NULL,
  canonical text NOT NULL,
  payload_bytes integer NOT NULL,
  checksum text NOT NULL
);

WITH clock AS (
  SELECT
    to_char(fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS fetched_at,
    to_char(stale_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS stale_at,
    to_char(hard_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS hard_expires_at,
    to_char(deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS deadline
  FROM graphql_price_change_clock
), payloads AS (
  SELECT jsonb_build_object(
    'schemaVersion', 2,
    'source', 'FPL_BOOTSTRAP',
    'fetchedAt', clock.fetched_at,
    'staleAt', clock.stale_at,
    'hardExpiresAt', clock.hard_expires_at,
    'deadline', clock.deadline,
    'nextDeadlines', jsonb_build_array(clock.deadline),
    'latestEvent', NULL,
    'expectedPlayerCount', 224,
    'observedPlayerCount', 224
  ) AS payload
  FROM clock
)
INSERT INTO graphql_price_change_items (item_name, payload, item_count, canonical, payload_bytes, checksum)
SELECT
  'context',
  payload,
  10,
  pg_temp.graphql_canonical_json(payload),
  octet_length(convert_to(pg_temp.graphql_canonical_json(payload), 'UTF8')),
  encode(sha256(convert_to(pg_temp.graphql_canonical_json(payload), 'UTF8')), 'hex')
FROM payloads;

WITH price_players AS (
  SELECT jsonb_agg(
    jsonb_build_object(
      'playerId', player.element_id,
      'playerCode', player.code,
      'webName', player.web_name,
      'teamId', player.team_id,
      'teamName', team.name,
      'teamShortName', team.short_name,
      'position', CASE player.element_type
        WHEN 1 THEN 'GKP'
        WHEN 2 THEN 'DEF'
        WHEN 3 THEN 'MID'
        WHEN 4 THEN 'FWD'
      END,
      'currentPrice', player.price,
      'selectedByPercent', 0,
      'progressPercent', 0,
      'hourlyRate', 0,
      'status', 'UNLIKELY',
      'ownershipTrend', 'FLAT',
      'transfersInEvent', 0,
      'transfersOutEvent', 0,
      'lockedUntil', NULL,
      'calibrating', FALSE,
      'projections', jsonb_build_array(
        jsonb_build_object(
          'offset', 0,
          'projectedPercent', 0,
          'likelihood', 0
        )
      )
    )
    ORDER BY player.element_id
  ) AS payload
  FROM fpl.players player
  JOIN fpl.teams team
    ON team.season_id = player.season_id
   AND team.team_id = player.team_id
  WHERE player.season_id = 2026
)
INSERT INTO graphql_price_change_items (item_name, payload, item_count, canonical, payload_bytes, checksum)
SELECT
  'players',
  price_players.payload,
  jsonb_array_length(price_players.payload),
  pg_temp.graphql_canonical_json(price_players.payload),
  octet_length(convert_to(pg_temp.graphql_canonical_json(price_players.payload), 'UTF8')),
  encode(sha256(convert_to(pg_temp.graphql_canonical_json(price_players.payload), 'UTF8')), 'hex')
FROM price_players;

WITH clock AS (
  SELECT * FROM graphql_price_change_clock
), manifest_items AS (
  SELECT jsonb_agg(
    jsonb_build_object(
      'name', item.item_name,
      'key', 'llm:data:fpl:price-changes:2627:'
        || (SELECT revision::text FROM graphql_price_change_identity)
        || ':' || item.item_name,
      'type', 'string',
      'count', item.item_count,
      'bytes', item.payload_bytes,
      'sha256', item.checksum
    ) ORDER BY CASE item.item_name WHEN 'context' THEN 1 WHEN 'players' THEN 2 END
  ) AS items
  FROM graphql_price_change_items item
), manifest AS (
  SELECT jsonb_build_object(
    'dataset', 'fpl:price-changes',
    'seasonCode', '2627',
    'eventId', NULL,
    'revision', (SELECT revision FROM graphql_price_change_identity),
    'publicationId', (SELECT publication_id::text FROM graphql_price_change_identity),
    'sourceCheckedAt', to_char(clock.fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'lastSuccessfulFetchAt', to_char(clock.fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'publishedAt', to_char(clock.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'state', 'active',
    'items', manifest_items.items
  ) AS value
  FROM clock CROSS JOIN manifest_items
)
INSERT INTO ops.dataset_publications (
  publication_id, dataset, season_id, event_id, revision, status, manifest,
  activated_at, expires_at, updated_at
)
SELECT
  (SELECT publication_id FROM graphql_price_change_identity),
  'fpl:price-changes',
  2026,
  NULL,
  (SELECT revision FROM graphql_price_change_identity),
  'active',
  manifest.value,
  clock.published_at,
  clock.hard_expires_at,
  clock.published_at
FROM clock CROSS JOIN manifest
ON CONFLICT (publication_id) DO UPDATE
SET dataset = EXCLUDED.dataset,
    season_id = EXCLUDED.season_id,
    event_id = EXCLUDED.event_id,
    revision = EXCLUDED.revision,
    status = EXCLUDED.status,
    manifest = EXCLUDED.manifest,
    activated_at = EXCLUDED.activated_at,
    retired_at = NULL,
    expires_at = EXCLUDED.expires_at,
    updated_at = EXCLUDED.updated_at;

INSERT INTO ops.dataset_publication_items (
  publication_id, item_name, payload, item_count, checksum
)
SELECT
  (SELECT publication_id FROM graphql_price_change_identity),
  item.item_name,
  item.payload,
  item.item_count,
  item.checksum
FROM graphql_price_change_items item
ON CONFLICT (publication_id, item_name) DO UPDATE
SET payload = EXCLUDED.payload,
    item_count = EXCLUDED.item_count,
    checksum = EXCLUDED.checksum;

-- Queue the Price Change manifest through the same durable Data delivery
-- contract used in production. The publication row is authoritative; Redis
-- receives this revision only when the delivery worker consumes the receipt.
INSERT INTO ops.data_publication_outbox (
  outbox_id,
  publication_id,
  source_run_id,
  dataset,
  season_id,
  event_id,
  manifest,
  status,
  available_at,
  attempts,
  lease_owner,
  lease_expires_at,
  staged_at,
  db_activated_at,
  redis_activated_at,
  delivered_at,
  last_error,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  publication.publication_id,
  NULL,
  publication.dataset,
  publication.season_id,
  publication.event_id,
  publication.manifest,
  'pending',
  publication.activated_at,
  0,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  publication.activated_at,
  publication.updated_at
FROM ops.dataset_publications publication
WHERE publication.publication_id = (SELECT publication_id FROM graphql_price_change_identity)
ON CONFLICT (publication_id) DO UPDATE
SET manifest = EXCLUDED.manifest,
    status = 'pending',
    available_at = EXCLUDED.available_at,
    attempts = 0,
    lease_owner = NULL,
    lease_expires_at = NULL,
    staged_at = NULL,
    db_activated_at = NULL,
    redis_activated_at = NULL,
    delivered_at = NULL,
    last_error = NULL,
    updated_at = EXCLUDED.updated_at;

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM ops.dataset_publications
    WHERE dataset = 'fpl:price-changes'
      AND season_id = 2026
      AND event_id IS NULL
      AND status = 'active'
  ) <> 1
    OR (
    SELECT count(*)
    FROM ops.dataset_publication_items
      WHERE publication_id = (SELECT publication_id FROM graphql_price_change_identity)
    ) <> 2
    OR (
      SELECT item_count
      FROM ops.dataset_publication_items
      WHERE publication_id = (SELECT publication_id FROM graphql_price_change_identity)
        AND item_name = 'players'
    ) <> 224
    OR (
      SELECT manifest->>'lastSuccessfulFetchAt' = manifest->>'sourceCheckedAt'
      FROM ops.dataset_publications
      WHERE publication_id = (SELECT publication_id FROM graphql_price_change_identity)
    ) IS NOT TRUE THEN
    RAISE EXCEPTION 'expected complete active Price Change publication fixture';
  END IF;
END
$$;

-- Live, Core, and Price Change fixture publications use explicit revisions so
-- their payloads remain deterministic. Advance the shared producer sequence
-- past every durable publication before any later canonical capture calls
-- nextval; otherwise the next writer can collide with an explicit revision.
SELECT setval(
  'ops.dataset_publication_revisions'::regclass,
  GREATEST(
    COALESCE((SELECT max(revision) FROM ops.dataset_publications), 0),
    (SELECT last_value FROM ops.dataset_publication_revisions),
    1
  ),
  TRUE
);

INSERT INTO competition.entry_event_picks (
  season_id,
  entry_id,
  event_id,
  position,
  element_id,
  multiplier,
  is_captain,
  is_vice_captain,
  active_chip,
  transfers,
  transfers_cost,
  source_pick_row_id,
  source_created_at,
  source_updated_at,
  event_team_id
)
SELECT
  2026,
  1,
  2,
  position,
  position,
  CASE
    WHEN position = 1 THEN 2
    WHEN position <= 11 THEN 1
    ELSE 0
  END,
  position = 1,
  position = 2,
  NULL,
  CASE WHEN position = 1 THEN 0 ELSE NULL END,
  CASE WHEN position = 1 THEN 0 ELSE NULL END,
  2000 + position,
  '2026-08-10T00:00:00.000Z',
  '2026-08-10T00:00:00.000Z',
  1
FROM generate_series(1, 15) AS position
ON CONFLICT (season_id, entry_id, event_id, position) DO UPDATE
SET
  element_id = EXCLUDED.element_id,
  multiplier = EXCLUDED.multiplier,
  is_captain = EXCLUDED.is_captain,
  is_vice_captain = EXCLUDED.is_vice_captain,
  active_chip = EXCLUDED.active_chip,
  transfers = EXCLUDED.transfers,
  transfers_cost = EXCLUDED.transfers_cost,
  source_pick_row_id = EXCLUDED.source_pick_row_id,
  source_created_at = EXCLUDED.source_created_at,
  source_updated_at = EXCLUDED.source_updated_at,
  event_team_id = EXCLUDED.event_team_id;

-- The event-2 rowset is the complete V2 entry input used by the cold
-- PostgreSQL fallback. The head hash is calculated from the exact normalized
-- object shape consumed by GraphQL, not from provider row ordering or heartbeat
-- timestamps.
WITH normalized AS (
  SELECT
    jsonb_agg(
      jsonb_build_object(
        'element', pick.element_id,
        'position', pick.position,
        'multiplier', pick.multiplier,
        'isCaptain', pick.is_captain,
        'isViceCaptain', pick.is_vice_captain
      ) ORDER BY pick.position
    ) AS picks,
    MAX(pick.active_chip::text) AS chip,
    MAX(pick.transfers_cost) AS transfer_cost,
    MAX(pick.source_updated_at) AS source_checked_at
  FROM competition.entry_event_picks pick
  WHERE pick.season_id = 2026
    AND pick.entry_id = 1
    AND pick.event_id = 2
), content AS (
  SELECT
    jsonb_build_object(
      'picks', normalized.picks,
      'chip', normalized.chip,
      'transferCost', normalized.transfer_cost
    ) AS value,
    normalized.source_checked_at
  FROM normalized
)
INSERT INTO competition.entry_event_pick_heads (
  season_id,
  entry_id,
  event_id,
  publication_id,
  generation,
  picks_base_revision,
  content_sha256,
  row_count,
  source_checked_at,
  content_updated_at,
  checkpointed_at,
  state
)
SELECT
  2026,
  1,
  2,
  gen_random_uuid()::text,
  1,
  encode(sha256(convert_to(pg_temp.graphql_canonical_json(content.value), 'UTF8')), 'hex'),
  encode(sha256(convert_to(pg_temp.graphql_canonical_json(content.value), 'UTF8')), 'hex'),
  jsonb_array_length(content.value -> 'picks'),
  content.source_checked_at,
  content.source_checked_at,
  content.source_checked_at,
  'COMPLETE'
FROM content
ON CONFLICT (season_id, entry_id, event_id) DO UPDATE
SET
  publication_id = EXCLUDED.publication_id,
  generation = EXCLUDED.generation,
  picks_base_revision = EXCLUDED.picks_base_revision,
  content_sha256 = EXCLUDED.content_sha256,
  row_count = EXCLUDED.row_count,
  source_checked_at = EXCLUDED.source_checked_at,
  content_updated_at = EXCLUDED.content_updated_at,
  checkpointed_at = EXCLUDED.checkpointed_at,
  state = EXCLUDED.state;

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM competition.entry_event_pick_heads head
    WHERE head.season_id = 2026
      AND head.entry_id = 1
      AND head.event_id = 2
      AND head.state = 'COMPLETE'
      AND head.row_count = 15
  ) <> 1 THEN
    RAISE EXCEPTION 'expected complete event-2 Entry Live V2 head authority fixture';
  END IF;
END
$$;

-- The public catalog is a complete season-owned set. Remove stale or
-- disabled rows before inserting the single advertised contract tournament;
-- leaving a competing row would make the reader select an ambiguous catalog.
DELETE FROM competition.public_league_trends
WHERE season_id = 2026;

INSERT INTO competition.public_league_trends (
  season_id,
  tournament_id,
  display_name,
  sort_order,
  enabled,
  published_at
) VALUES (
  2026,
  2147483000,
  'GraphQL contract public trend',
  1,
  TRUE,
  '2026-08-10T00:00:03.000Z'
)
ON CONFLICT (season_id, tournament_id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    sort_order = EXCLUDED.sort_order,
    enabled = EXCLUDED.enabled,
    published_at = EXCLUDED.published_at,
    updated_at = '2026-08-10T00:00:03.000Z';

-- Reproduce the producer's source checksum before choosing a publication
-- revision. A matching READY/COLLECTING checksum is reused by the canonical
-- publisher; only a changed source is allocated a new revision.
DROP TABLE IF EXISTS pg_temp.graphql_trends_source;
CREATE TEMP TABLE graphql_trends_source (
  event_id integer PRIMARY KEY,
  source_watermark timestamptz NOT NULL,
  roster_checksum text NOT NULL,
  player_metadata_checksum text NOT NULL,
  source_checksum text NOT NULL,
  expected_entries integer NOT NULL,
  complete_pick_entries integer NOT NULL,
  transfer_checkpoint_entries integer NOT NULL
);

INSERT INTO graphql_trends_source (
  event_id,
  source_watermark,
  roster_checksum,
  player_metadata_checksum,
  source_checksum,
  expected_entries,
  complete_pick_entries,
  transfer_checkpoint_entries
)
VALUES (
  1,
  '2026-08-10T00:00:00.000Z',
  md5('1'),
  md5(''),
  encode(sha256(convert_to(format(
    '%s:%s:%s:%s:%s:%s:%s:%s:%s',
    2026,
    2147483000,
    1,
    0,
    0,
    0,
    '2026-08-10T00:00:00.000Z',
    md5('1'),
    md5('')
  ), 'UTF8')), 'hex'),
  0,
  0,
  0
);

WITH source AS (
  SELECT
    max(GREATEST(
      COALESCE(pick.source_updated_at, '-infinity'::timestamptz),
      COALESCE(entry.updated_at, '-infinity'::timestamptz),
      COALESCE(transfer.updated_at, '-infinity'::timestamptz)
    )) AS source_watermark,
    md5(COALESCE(string_agg(roster.entry_id::text, ',' ORDER BY roster.entry_id), '')) AS roster_checksum,
    md5(COALESCE((
      SELECT string_agg(
        format('%s:%s:%s:%s', metadata.element_id, metadata.player_name, metadata.player_position, metadata.team_short_name),
        ',' ORDER BY metadata.element_id
      )
      FROM (
        SELECT DISTINCT elements.element_id,
          COALESCE(NULLIF(concat_ws(' ', player.first_name, player.second_name), ''), player.web_name) AS player_name,
          player.element_type AS player_position,
          team.short_name AS team_short_name
        FROM (
          SELECT pick_row.element_id
          FROM competition.entry_event_picks pick_row
          JOIN competition.tournament_entries pick_roster
            ON pick_roster.season_id = pick_row.season_id
           AND pick_roster.entry_id = pick_row.entry_id
          WHERE pick_row.season_id = 2026
            AND pick_row.event_id = 2
            AND pick_roster.tournament_id = 2147483000
          UNION
          SELECT transfer_row.element_in_id
          FROM competition.entry_event_transfers transfer_row
          JOIN competition.tournament_entries in_roster
            ON in_roster.season_id = transfer_row.season_id
           AND in_roster.entry_id = transfer_row.entry_id
          WHERE transfer_row.season_id = 2026
            AND transfer_row.event_id = 2
            AND in_roster.tournament_id = 2147483000
            AND transfer_row.element_in_id IS NOT NULL
          UNION
          SELECT transfer_row.element_out_id
          FROM competition.entry_event_transfers transfer_row
          JOIN competition.tournament_entries out_roster
            ON out_roster.season_id = transfer_row.season_id
           AND out_roster.entry_id = transfer_row.entry_id
          WHERE transfer_row.season_id = 2026
            AND transfer_row.event_id = 2
            AND out_roster.tournament_id = 2147483000
            AND transfer_row.element_out_id IS NOT NULL
        ) elements
        JOIN fpl.players player
          ON player.season_id = 2026
         AND player.element_id = elements.element_id
        JOIN fpl.teams team
          ON team.season_id = player.season_id
         AND team.team_id = player.team_id
      ) metadata
    ), '')) AS player_metadata_checksum
  FROM competition.tournament_entries roster
  JOIN competition.entries entry
    ON entry.season_id = roster.season_id
   AND entry.entry_id = roster.entry_id
  LEFT JOIN competition.entry_event_picks pick
    ON pick.season_id = roster.season_id
   AND pick.entry_id = roster.entry_id
   AND pick.event_id = 2
  LEFT JOIN competition.entry_event_transfers transfer
    ON transfer.season_id = roster.season_id
   AND transfer.entry_id = roster.entry_id
   AND transfer.event_id = 2
  WHERE roster.season_id = 2026
    AND roster.tournament_id = 2147483000
), prepared AS (
  SELECT
    source.*,
    encode(sha256(convert_to(format(
      '%s:%s:%s:%s:%s:%s:%s:%s:%s',
      2026,
      2147483000,
      2,
      1,
      1,
      1,
      to_char(source.source_watermark AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      source.roster_checksum,
      source.player_metadata_checksum
    ), 'UTF8')), 'hex') AS source_checksum
  FROM source
)
INSERT INTO graphql_trends_source (
  event_id,
  source_watermark,
  roster_checksum,
  player_metadata_checksum,
  source_checksum,
  expected_entries,
  complete_pick_entries,
  transfer_checkpoint_entries
)
SELECT
  2,
  source_watermark,
  roster_checksum,
  player_metadata_checksum,
  source_checksum,
  1,
  1,
  1
FROM prepared;

-- Preserve every historical publication in the reserved scope. Reuse the
-- existing publication when its source checksum is unchanged; otherwise the
-- producer allocates the next revision strictly above the event's maximum.
DROP TABLE IF EXISTS pg_temp.graphql_trends_revision;
CREATE TEMP TABLE graphql_trends_revision (
  event_id integer PRIMARY KEY,
  revision bigint NOT NULL,
  reused boolean NOT NULL
);
INSERT INTO graphql_trends_revision (event_id, revision, reused)
SELECT
  seeded.event_id,
  CASE
    WHEN existing.publication_state IN ('READY', 'COLLECTING')
      AND existing.is_active THEN existing.revision
    ELSE GREATEST(7::bigint, maximum.max_revision + 1)
  END,
  COALESCE(
    existing.publication_state IN ('READY', 'COLLECTING')
      AND existing.is_active,
    FALSE
  )
FROM (VALUES (1), (2)) AS seeded(event_id)
JOIN graphql_trends_source source
  ON source.event_id = seeded.event_id
LEFT JOIN LATERAL (
  SELECT publication.revision, publication.publication_state, publication.is_active
  FROM reporting.tournament_selection_stat_publications publication
  WHERE publication.season_id = 2026
    AND publication.tournament_id = 2147483000
    AND publication.event_id = seeded.event_id
    AND publication.source_checksum = source.source_checksum
  ORDER BY publication.revision DESC
  LIMIT 1
) existing ON TRUE
LEFT JOIN LATERAL (
  SELECT COALESCE(max(publication.revision), 0)::bigint AS max_revision
  FROM reporting.tournament_selection_stat_publications publication
  WHERE publication.season_id = 2026
    AND publication.tournament_id = 2147483000
    AND publication.event_id = seeded.event_id
) maximum ON TRUE;

UPDATE reporting.tournament_selection_stat_publications
SET is_active = FALSE
WHERE season_id = 2026
  AND tournament_id = 2147483000
  AND event_id IN (1, 2)
  AND is_active
  AND NOT EXISTS (
    SELECT 1
    FROM graphql_trends_revision decision
    WHERE decision.event_id = reporting.tournament_selection_stat_publications.event_id
      AND decision.reused
  );

-- Re-seeding an intentionally collecting publication must not retain trend
-- rows from a prior run. Remove only rows owned by the current revision;
-- historical rows remain immutable.
DELETE FROM reporting.tournament_selection_stat_rows trend_row
USING reporting.tournament_selection_stat_publications publication
WHERE trend_row.publication_id = publication.publication_id
  AND publication.season_id = 2026
  AND publication.tournament_id = 2147483000
  AND publication.event_id = 1
  AND publication.revision = (
    SELECT revision FROM graphql_trends_revision WHERE event_id = 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM graphql_trends_revision WHERE event_id = 1 AND reused
  );

INSERT INTO reporting.tournament_selection_stat_publications (
  season_id,
  tournament_id,
  event_id,
  revision,
  publication_state,
  is_active,
  method_key,
  method_version,
  source_policy_version,
  source_watermark,
  source_checksum,
  expected_entries,
  complete_pick_entries,
  transfer_checkpoint_entries,
  ownership_state,
  captaincy_state,
  vice_captaincy_state,
  transfers_state,
  captured_at,
  published_at
) VALUES (
  2026,
  2147483000,
  1,
  (SELECT revision FROM graphql_trends_revision WHERE event_id = 1),
  'COLLECTING',
  FALSE,
  'exact_prepared_competition',
  '1',
  '1',
  (SELECT source_watermark FROM graphql_trends_source WHERE event_id = 1),
  (SELECT source_checksum FROM graphql_trends_source WHERE event_id = 1),
  (SELECT expected_entries FROM graphql_trends_source WHERE event_id = 1),
  (SELECT complete_pick_entries FROM graphql_trends_source WHERE event_id = 1),
  (SELECT transfer_checkpoint_entries FROM graphql_trends_source WHERE event_id = 1),
  'NOT_READY',
  'NOT_READY',
  'NOT_READY',
  'NOT_READY',
  '2026-08-10T00:00:03.000Z',
  NULL
)
ON CONFLICT (season_id, tournament_id, event_id, revision) DO UPDATE
SET publication_state = EXCLUDED.publication_state,
    is_active = EXCLUDED.is_active,
    method_key = EXCLUDED.method_key,
    method_version = EXCLUDED.method_version,
    source_policy_version = EXCLUDED.source_policy_version,
    source_watermark = EXCLUDED.source_watermark,
    source_checksum = EXCLUDED.source_checksum,
    expected_entries = EXCLUDED.expected_entries,
    complete_pick_entries = EXCLUDED.complete_pick_entries,
    transfer_checkpoint_entries = EXCLUDED.transfer_checkpoint_entries,
    ownership_state = EXCLUDED.ownership_state,
    captaincy_state = EXCLUDED.captaincy_state,
    vice_captaincy_state = EXCLUDED.vice_captaincy_state,
    transfers_state = EXCLUDED.transfers_state,
    captured_at = EXCLUDED.captured_at,
    published_at = EXCLUDED.published_at
WHERE NOT EXISTS (
  SELECT 1 FROM graphql_trends_revision WHERE event_id = 1 AND reused
);

-- Event 2 is the eligible, fully captured counterpart used by the public
-- Trends contract. It is seeded from the same roster, picks and player/team
-- rows that the producer reads, while event 1 above remains collecting and
-- inactive because the entry joined only from event 2 onward.
DELETE FROM reporting.tournament_selection_stat_rows trend_row
USING reporting.tournament_selection_stat_publications publication
WHERE trend_row.publication_id = publication.publication_id
  AND publication.season_id = 2026
  AND publication.tournament_id = 2147483000
  AND publication.event_id = 2
  AND publication.revision = (
    SELECT revision FROM graphql_trends_revision WHERE event_id = 2
  )
  AND NOT EXISTS (
    SELECT 1 FROM graphql_trends_revision WHERE event_id = 2 AND reused
  );

WITH source AS (
  SELECT
    source_watermark,
    roster_checksum,
    player_metadata_checksum,
    source_checksum
  FROM graphql_trends_source
  WHERE event_id = 2
), prepared AS (
  SELECT source.*
  FROM source
)
INSERT INTO reporting.tournament_selection_stat_publications (
  season_id,
  tournament_id,
  event_id,
  revision,
  publication_state,
  is_active,
  method_key,
  method_version,
  source_policy_version,
  source_watermark,
  source_checksum,
  expected_entries,
  complete_pick_entries,
  transfer_checkpoint_entries,
  ownership_state,
  captaincy_state,
  vice_captaincy_state,
  transfers_state,
  captured_at,
  published_at
)
SELECT
  2026,
  2147483000,
  2,
  (SELECT revision FROM graphql_trends_revision WHERE event_id = 2),
  'READY',
  FALSE,
  'exact_prepared_competition',
  '1',
  '1',
  source_watermark,
  source_checksum,
  1,
  1,
  1,
  'READY',
  'READY',
  'READY',
  'READY',
  '2026-08-10T00:00:04.000Z',
  '2026-08-10T00:00:04.000Z'
FROM prepared
WHERE NOT EXISTS (
  SELECT 1 FROM graphql_trends_revision WHERE event_id = 2 AND reused
)
ON CONFLICT (season_id, tournament_id, event_id, revision) DO UPDATE
SET publication_state = EXCLUDED.publication_state,
    is_active = EXCLUDED.is_active,
    method_key = EXCLUDED.method_key,
    method_version = EXCLUDED.method_version,
    source_policy_version = EXCLUDED.source_policy_version,
    source_watermark = EXCLUDED.source_watermark,
    source_checksum = EXCLUDED.source_checksum,
    expected_entries = EXCLUDED.expected_entries,
    complete_pick_entries = EXCLUDED.complete_pick_entries,
    transfer_checkpoint_entries = EXCLUDED.transfer_checkpoint_entries,
    ownership_state = EXCLUDED.ownership_state,
    captaincy_state = EXCLUDED.captaincy_state,
    vice_captaincy_state = EXCLUDED.vice_captaincy_state,
    transfers_state = EXCLUDED.transfers_state,
    captured_at = EXCLUDED.captured_at,
    published_at = EXCLUDED.published_at
WHERE NOT EXISTS (
  SELECT 1 FROM graphql_trends_revision WHERE event_id = 2 AND reused
);

INSERT INTO reporting.tournament_selection_stat_rows (
  publication_id,
  element_id,
  selected_count,
  effective_selection_count,
  captain_count,
  vice_captain_count,
  transfer_in_count,
  transfer_out_count,
  player_name,
  player_position,
  team_short_name
)
SELECT
  publication.publication_id,
  pick.element_id,
  count(*)::integer,
  sum(pick.multiplier)::integer,
  count(*) FILTER (WHERE pick.is_captain)::integer,
  count(*) FILTER (WHERE pick.is_vice_captain)::integer,
  0,
  0,
  COALESCE(NULLIF(concat_ws(' ', player.first_name, player.second_name), ''), player.web_name),
  player.element_type,
  team.short_name
FROM reporting.tournament_selection_stat_publications publication
JOIN competition.entry_event_picks pick
  ON pick.season_id = publication.season_id
 AND pick.event_id = publication.event_id
JOIN competition.tournament_entries roster
  ON roster.season_id = pick.season_id
 AND roster.entry_id = pick.entry_id
 AND roster.tournament_id = publication.tournament_id
JOIN fpl.players player
  ON player.season_id = pick.season_id
 AND player.element_id = pick.element_id
JOIN fpl.teams team
  ON team.season_id = player.season_id
 AND team.team_id = player.team_id
WHERE publication.season_id = 2026
  AND publication.tournament_id = 2147483000
  AND publication.event_id = 2
  AND publication.revision = (
    SELECT revision FROM graphql_trends_revision WHERE event_id = 2
  )
  AND NOT EXISTS (
    SELECT 1 FROM graphql_trends_revision WHERE event_id = 2 AND reused
  )
GROUP BY publication.publication_id,
  pick.element_id,
  player.first_name,
  player.second_name,
  player.web_name,
  player.element_type,
  team.short_name
ON CONFLICT (publication_id, element_id) DO UPDATE
SET selected_count = EXCLUDED.selected_count,
    effective_selection_count = EXCLUDED.effective_selection_count,
    captain_count = EXCLUDED.captain_count,
    vice_captain_count = EXCLUDED.vice_captain_count,
    transfer_in_count = EXCLUDED.transfer_in_count,
    transfer_out_count = EXCLUDED.transfer_out_count,
    player_name = EXCLUDED.player_name,
    player_position = EXCLUDED.player_position,
    team_short_name = EXCLUDED.team_short_name
WHERE NOT EXISTS (
  SELECT 1 FROM graphql_trends_revision WHERE event_id = 2 AND reused
);

UPDATE reporting.tournament_selection_stat_publications
SET is_active = TRUE
WHERE season_id = 2026
  AND tournament_id = 2147483000
  AND event_id = 2
  AND revision = (
    SELECT revision FROM graphql_trends_revision WHERE event_id = 2
  )
  AND NOT EXISTS (
    SELECT 1 FROM graphql_trends_revision WHERE event_id = 2 AND reused
  );

-- Keep historical My FPL revisions intact. A fresh database retains the
-- contract's reserved revision 7; a rerun above an existing publication
-- allocates the next scope revision so PostgreSQL and Redis never move back
-- to an older active revision.
DROP TABLE IF EXISTS pg_temp.graphql_my_fpl_revision;
CREATE TEMP TABLE graphql_my_fpl_revision (
  revision bigint PRIMARY KEY
);
INSERT INTO graphql_my_fpl_revision (revision)
SELECT CASE
  WHEN max(publication.revision) IS NULL THEN 7::bigint
  ELSE GREATEST(7::bigint, max(publication.revision) + 1)
END
FROM competition.my_fpl_snapshot_publications publication
WHERE publication.season_id = 2026
  AND publication.event_id = 1;

UPDATE competition.my_fpl_snapshot_publications
SET active = FALSE,
    updated_at = now()
WHERE season_id = 2026
  AND event_id = 1
  AND active;

DELETE FROM competition.my_fpl_snapshot_entries
WHERE season_id = 2026
  AND event_id = 1
  AND revision = (SELECT revision FROM graphql_my_fpl_revision);

DELETE FROM competition.my_fpl_snapshot_tournament_rows
WHERE season_id = 2026
  AND event_id = 1
  AND revision = (SELECT revision FROM graphql_my_fpl_revision);

DELETE FROM competition.my_fpl_snapshot_tournament_aggregates
WHERE season_id = 2026
  AND event_id = 1
  AND revision = (SELECT revision FROM graphql_my_fpl_revision);

INSERT INTO competition.my_fpl_snapshot_publications (
  season_id,
  event_id,
  revision,
  snapshot_date,
  source_checked_at,
  published_at,
  kind,
  active,
  expected_entry_count,
  ready_entry_count,
  empty_entry_count,
  not_applicable_entry_count,
  expected_tournament_count,
  ready_tournament_count,
  content_sha256,
  score_source,
  override_actor,
  override_reason,
  idempotency_key,
  live_publication_id,
  live_revision,
  algorithm_version,
  source_min_checked_at,
  source_max_checked_at
) VALUES (
  2026,
  1,
  (SELECT revision FROM graphql_my_fpl_revision),
  '2026-08-10',
  '2026-08-10T00:00:00.000Z',
  '2026-08-10T00:00:01.000Z',
  'FINAL',
  TRUE,
  0,
  0,
  0,
  1,
  2,
  2,
  repeat('0', 64),
  'FPL_FINAL_RESULT',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-10T00:00:00.000Z',
  '2026-08-10T00:00:00.000Z'
)
ON CONFLICT (season_id, event_id, revision) DO UPDATE
SET
  snapshot_date = EXCLUDED.snapshot_date,
  source_checked_at = EXCLUDED.source_checked_at,
  published_at = EXCLUDED.published_at,
  kind = EXCLUDED.kind,
  active = EXCLUDED.active,
  expected_entry_count = EXCLUDED.expected_entry_count,
  ready_entry_count = EXCLUDED.ready_entry_count,
  empty_entry_count = EXCLUDED.empty_entry_count,
  not_applicable_entry_count = EXCLUDED.not_applicable_entry_count,
  expected_tournament_count = EXCLUDED.expected_tournament_count,
  ready_tournament_count = EXCLUDED.ready_tournament_count,
  content_sha256 = EXCLUDED.content_sha256,
  score_source = EXCLUDED.score_source,
  override_actor = NULL,
  override_reason = NULL,
  idempotency_key = NULL,
  live_publication_id = NULL,
  live_revision = NULL,
  algorithm_version = NULL,
  source_min_checked_at = EXCLUDED.source_min_checked_at,
  source_max_checked_at = EXCLUDED.source_max_checked_at,
  updated_at = now();

-- The GraphQL reader hard-cut validates that every active publication carries
-- the canonical entry/tournament scope hashes exposed by the Data-owned
-- status view. Populate the fixture from that same authority rather than
-- duplicating hash literals that could drift when the sentinel roster changes.
UPDATE competition.my_fpl_snapshot_publications AS publication
SET entry_scope_sha256 = status.expected_entry_scope_sha256,
    tournament_scope_sha256 = status.expected_tournament_scope_sha256,
    updated_at = now()
FROM reporting.my_fpl_active_snapshot_status AS status
WHERE publication.season_id = status.season_id
  AND publication.event_id = status.event_id
  AND publication.revision = status.revision
  AND publication.season_id = 2026
  AND publication.event_id = 1
  AND publication.revision = (SELECT revision FROM graphql_my_fpl_revision)
  AND publication.active;

-- Revision is an explicit retained authority row in this fixture. Keep the
-- producer's global sequence ahead of it so the next canonical capture cannot
-- allocate a revision below the fixture row and leave Redis/SQL on
-- conflicting active revisions.
SELECT setval(
  'competition.my_fpl_snapshot_revision_seq'::regclass,
  GREATEST(
    (SELECT revision FROM graphql_my_fpl_revision),
    COALESCE((SELECT max(revision) FROM competition.my_fpl_snapshot_publications), 0),
    (SELECT last_value FROM competition.my_fpl_snapshot_revision_seq)
  ),
  TRUE
);

-- The reserved late-entry tournament has no eligible group result at event 1.
-- Remove retained source rows before publishing the authenticated null ranks.
DELETE FROM competition.tournament_points_group_results
WHERE season_id = 2026
  AND tournament_id IN (2147483000, 2147483001);

INSERT INTO competition.my_fpl_snapshot_entries (
  season_id,
  event_id,
  revision,
  entry_id,
  picks_count,
  is_empty,
  payload
) VALUES (
  2026,
  1,
  (SELECT revision FROM graphql_my_fpl_revision),
  1,
  0,
  TRUE,
  jsonb_build_object(
      'contractVersion', 2,
      'entry', jsonb_build_object(
      'id', 1,
      'entryName', 'GraphQL contract sentinel',
      'playerName', 'GraphQL contract sentinel',
      'region', NULL,
      'startedEvent', 2,
      'overallPoints', NULL,
      'overallRank', NULL,
      'bank', NULL,
      'teamValue', NULL,
      'totalTransfers', NULL,
      'transfersSyncedThroughEventId', 2,
      'pastSeasonsCheckedAt', '2026-08-10T00:00:00.000Z',
      'pastSeasonsCount', 0
    ),
    'pastSeasons', jsonb_build_array(),
    'gameweek', jsonb_build_object('state', 'EMPTY', 'eventId', 1, 'result', NULL),
    'review', jsonb_build_object(
      'throughEventId', 1,
      'timeline', jsonb_build_array(),
      'summary', jsonb_build_object(
        'gameweeksReviewed', 0,
        'provisionalGameweeks', 0,
        'totalNetPoints', 0,
        'averageNetPoints', 0,
        'medianNetPoints', 0,
        'bestGameweekId', NULL,
        'bestNetPoints', NULL,
        'worstGameweekId', NULL,
        'worstNetPoints', NULL,
        'totalHitPoints', 0,
        'hitGameweeks', 0,
        'totalBenchPoints', 0,
        'averageBenchPoints', 0,
        'zeroBenchGameweeks', 0,
        'highBenchGameweeks', 0,
        'totalAutoSubPoints', 0,
        'autoSubGameweeks', 0,
        'totalCaptainPoints', 0,
        'uniqueCaptains', 0,
        'captainBlankGameweeks', 0,
        'topCaptainWebName', NULL,
        'topCaptainGameweeks', 0,
        'topCaptainRate', 0,
        'bestOverallRank', NULL,
        'worstOverallRank', NULL,
        'overallRankChange', NULL,
        'currentImprovementStreak', 0,
        'longestImprovementStreak', 0,
        'formations', jsonb_build_array(),
        'positionPoints', jsonb_build_object(
          'goalkeeper', 0,
          'defender', 0,
          'midfielder', 0,
          'forward', 0,
          'assistantManager', 0,
          'total', 0
        ),
        'chips', jsonb_build_array()
      ),
      'holdings', jsonb_build_array(),
      'transfers', jsonb_build_array()
    )
  )
)
ON CONFLICT (season_id, event_id, revision, entry_id) DO UPDATE
SET
  picks_count = EXCLUDED.picks_count,
  is_empty = EXCLUDED.is_empty,
  payload = EXCLUDED.payload;

INSERT INTO competition.my_fpl_snapshot_tournament_rows (
  season_id,
  event_id,
  revision,
  tournament_id,
  entry_id,
  payload
) VALUES (
  2026,
  1,
  (SELECT revision FROM graphql_my_fpl_revision),
  2147483000,
  1,
  jsonb_build_object(
    'entryId', 1,
    'entryName', 'GraphQL contract sentinel',
    'groupId', NULL,
    'rank', NULL,
    'fieldRank', NULL,
    'eventId', 1,
    'playerName', 'GraphQL contract sentinel',
    'eventPoints', NULL,
    'eventCost', NULL,
    'eventNetPoints', NULL,
    'eventRank', NULL,
    'overallPoints', NULL,
    'overallRank', NULL,
    'eventChip', 'NONE',
    'captainId', NULL,
    'captainWebName', NULL,
    'captainTeamShortName', NULL,
    'captainPoints', NULL,
    'teamValue', NULL,
    'bank', NULL,
    'previousEventNetPoints', NULL,
    'previousRank', NULL,
    'inputRevision', NULL,
    'scoreRevision', NULL
  )
)
ON CONFLICT (season_id, event_id, revision, tournament_id, entry_id) DO UPDATE
SET payload = EXCLUDED.payload;

INSERT INTO competition.my_fpl_snapshot_tournament_rows (
  season_id,
  event_id,
  revision,
  tournament_id,
  entry_id,
  payload
)
SELECT
  season_id,
  event_id,
  revision,
  2147483001,
  entry_id,
  payload
FROM competition.my_fpl_snapshot_tournament_rows
WHERE season_id = 2026
  AND event_id = 1
  AND revision = (SELECT revision FROM graphql_my_fpl_revision)
  AND tournament_id = 2147483000
  AND entry_id = 1
ON CONFLICT (season_id, event_id, revision, tournament_id, entry_id) DO UPDATE
SET payload = EXCLUDED.payload;

INSERT INTO competition.my_fpl_snapshot_tournament_aggregates (
  season_id,
  event_id,
  revision,
  tournament_id,
  payload
) VALUES (
  2026,
  1,
  (SELECT revision FROM graphql_my_fpl_revision),
  2147483000,
  jsonb_build_object(
    'eventId', 1,
    'entryCount', 1,
    'leaderOverallPoints', NULL,
    'secondOverallPoints', NULL,
    'gapFirstSecond', NULL,
    'averageOverallPoints', NULL,
    'metrics', jsonb_build_array(
      jsonb_build_object(
        'key', 'OVERALL_POINTS', 'leaderValue', NULL, 'leaderEntryId', NULL,
        'leaderEntryName', NULL, 'leaderPlayerName', NULL, 'averageValue', NULL,
        'higherIsBetter', TRUE
      ),
      jsonb_build_object(
        'key', 'TEAM_VALUE', 'leaderValue', NULL, 'leaderEntryId', NULL,
        'leaderEntryName', NULL, 'leaderPlayerName', NULL, 'averageValue', NULL,
        'higherIsBetter', TRUE
      ),
      jsonb_build_object(
        'key', 'TRANSFERS', 'leaderValue', 0, 'leaderEntryId', 1,
        'leaderEntryName', 'GraphQL contract sentinel', 'leaderPlayerName', 'GraphQL contract sentinel', 'averageValue', 0,
        'higherIsBetter', FALSE
      ),
      jsonb_build_object(
        'key', 'TOTAL_COSTS', 'leaderValue', 0, 'leaderEntryId', 1,
        'leaderEntryName', 'GraphQL contract sentinel', 'leaderPlayerName', 'GraphQL contract sentinel', 'averageValue', 0,
        'higherIsBetter', FALSE
      ),
      jsonb_build_object(
        'key', 'BENCH_POINTS', 'leaderValue', 0, 'leaderEntryId', 1,
        'leaderEntryName', 'GraphQL contract sentinel', 'leaderPlayerName', 'GraphQL contract sentinel', 'averageValue', 0,
        'higherIsBetter', TRUE
      ),
      jsonb_build_object(
        'key', 'AUTO_SUB_POINTS', 'leaderValue', 0, 'leaderEntryId', 1,
        'leaderEntryName', 'GraphQL contract sentinel', 'leaderPlayerName', 'GraphQL contract sentinel', 'averageValue', 0,
        'higherIsBetter', TRUE
      )
    ),
    'viewers', jsonb_build_object(
      '1', jsonb_build_object(
        'entryId', 1,
        'overallRank', NULL,
        'tournamentOverallRank', NULL,
        'teamValue', NULL,
        'tournamentTeamValueRank', NULL,
        'transfersNum', 0,
        'tournamentTransfersRank', NULL,
        'totalCosts', 0,
        'tournamentCostsRank', NULL,
        'totalBenchPoints', 0,
        'tournamentBenchPointsRank', NULL,
        'autoSubPoints', 0,
        'tournamentAutoSubRank', NULL,
        'overallPoints', NULL,
        'leaderOverallPoints', NULL,
        'gapToLeader', NULL,
        'pointsBehindNext', NULL,
        'pointsAheadOfPrev', NULL
      )
    ),
    'topPerformers', jsonb_build_array(),
    'risers', jsonb_build_array(),
    'fallers', jsonb_build_array(),
    'captainDistribution', jsonb_build_array(),
    'chipDistribution', jsonb_build_array(),
    'seasonPath', jsonb_build_array(),
    'seasonPaths', jsonb_build_object('1', jsonb_build_array()),
    'tournamentId', 2147483000
  )
)
ON CONFLICT (season_id, event_id, revision, tournament_id) DO UPDATE
SET payload = EXCLUDED.payload;

INSERT INTO competition.my_fpl_snapshot_tournament_aggregates (
  season_id,
  event_id,
  revision,
  tournament_id,
  payload
)
SELECT
  season_id,
  event_id,
  revision,
  2147483001,
  jsonb_set(payload, '{tournamentId}', to_jsonb(2147483001), TRUE)
FROM competition.my_fpl_snapshot_tournament_aggregates
WHERE season_id = 2026
  AND event_id = 1
  AND revision = (SELECT revision FROM graphql_my_fpl_revision)
  AND tournament_id = 2147483000
ON CONFLICT (season_id, event_id, revision, tournament_id) DO UPDATE
SET payload = EXCLUDED.payload;

-- The immutable My FPL publication hash must authenticate the exact child
-- payloads above. PostgreSQL jsonb text uses the same length-then-byte key
-- ordering as Data's postgresJsonbCanonicalJson helper.
WITH content AS (
  SELECT
    publication.season_id,
    publication.event_id,
    publication.revision,
    jsonb_build_object(
      'seasonId', publication.season_id,
      'eventId', publication.event_id,
      'kind', publication.kind,
      'snapshotDate', publication.snapshot_date,
      'entries', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object('entry_id', entry_row.entry_id, 'payload', entry_row.payload)
          ORDER BY entry_row.entry_id
        )
        FROM competition.my_fpl_snapshot_entries entry_row
        WHERE entry_row.season_id = publication.season_id
          AND entry_row.event_id = publication.event_id
          AND entry_row.revision = publication.revision
      ), '[]'::jsonb),
      'tournaments', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'tournament_id', row_data.tournament_id,
            'entry_id', row_data.entry_id,
            'payload', row_data.payload
          )
          ORDER BY row_data.tournament_id, row_data.entry_id
        )
        FROM competition.my_fpl_snapshot_tournament_rows row_data
        WHERE row_data.season_id = publication.season_id
          AND row_data.event_id = publication.event_id
          AND row_data.revision = publication.revision
      ), '[]'::jsonb),
      'aggregates', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object('tournament_id', aggregate_data.tournament_id, 'payload', aggregate_data.payload)
          ORDER BY aggregate_data.tournament_id
        )
        FROM competition.my_fpl_snapshot_tournament_aggregates aggregate_data
        WHERE aggregate_data.season_id = publication.season_id
          AND aggregate_data.event_id = publication.event_id
          AND aggregate_data.revision = publication.revision
      ), '[]'::jsonb)
    )::text AS canonical
  FROM competition.my_fpl_snapshot_publications publication
  WHERE publication.season_id = 2026
    AND publication.event_id = 1
    AND publication.revision = (SELECT revision FROM graphql_my_fpl_revision)
)
UPDATE competition.my_fpl_snapshot_publications publication
SET content_sha256 = encode(sha256(convert_to(content.canonical, 'UTF8')), 'hex')
FROM content
WHERE publication.season_id = content.season_id
  AND publication.event_id = content.event_id
  AND publication.revision = content.revision;

-- The publication children and content hash are replaced on every fixture
-- run. Rebuild the durable Redis receipt as well, otherwise a retained
-- pending or delivered outbox row can publish the previous manifest after
-- this publication becomes active. This mirrors the normal republish
-- migration: update an existing receipt and create one when it is missing.
UPDATE competition.my_fpl_snapshot_publication_outbox AS outbox
SET manifest = jsonb_build_object(
      'dataset', 'fpl:my-fpl',
      'seasonCode', season.season_code,
      'eventId', publication.event_id,
      'revision', publication.revision,
      'snapshotDate', publication.snapshot_date,
      'sourceCheckedAt', publication.source_checked_at,
      'publishedAt', publication.published_at,
      'kind', publication.kind,
      'contentSha256', publication.content_sha256,
      'scoreSource', publication.score_source,
      'livePublicationId', NULL,
      'liveRevision', NULL,
      'algorithmVersion', NULL,
      'sourceMinCheckedAt', publication.source_min_checked_at,
      'sourceMaxCheckedAt', publication.source_max_checked_at
    ),
    status = 'PENDING',
    available_at = publication.published_at,
    delivered_at = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error = NULL,
    updated_at = publication.published_at
FROM competition.my_fpl_snapshot_publications AS publication
JOIN fpl.seasons AS season
  ON season.season_id = publication.season_id
WHERE outbox.season_id = publication.season_id
  AND outbox.event_id = publication.event_id
  AND outbox.revision = publication.revision
  AND publication.season_id = 2026
  AND publication.event_id = 1
  AND publication.revision = (SELECT revision FROM graphql_my_fpl_revision)
  AND publication.kind = 'FINAL'
  AND publication.active;

INSERT INTO competition.my_fpl_snapshot_publication_outbox (
  outbox_id,
  season_id,
  event_id,
  revision,
  manifest,
  status,
  available_at,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  publication.season_id,
  publication.event_id,
  publication.revision,
  jsonb_build_object(
    'dataset', 'fpl:my-fpl',
    'seasonCode', season.season_code,
    'eventId', publication.event_id,
    'revision', publication.revision,
    'snapshotDate', publication.snapshot_date,
    'sourceCheckedAt', publication.source_checked_at,
    'publishedAt', publication.published_at,
    'kind', publication.kind,
    'contentSha256', publication.content_sha256,
    'scoreSource', publication.score_source,
    'livePublicationId', NULL,
    'liveRevision', NULL,
    'algorithmVersion', NULL,
    'sourceMinCheckedAt', publication.source_min_checked_at,
    'sourceMaxCheckedAt', publication.source_max_checked_at
  ),
  'PENDING',
  publication.published_at,
  publication.published_at,
  publication.published_at
FROM competition.my_fpl_snapshot_publications AS publication
JOIN fpl.seasons AS season
  ON season.season_id = publication.season_id
LEFT JOIN competition.my_fpl_snapshot_publication_outbox AS outbox
  ON outbox.season_id = publication.season_id
 AND outbox.event_id = publication.event_id
 AND outbox.revision = publication.revision
WHERE publication.season_id = 2026
  AND publication.event_id = 1
  AND publication.revision = (SELECT revision FROM graphql_my_fpl_revision)
  AND publication.kind = 'FINAL'
  AND publication.active
  AND outbox.outbox_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM competition.my_fpl_snapshot_publications publication
    JOIN competition.my_fpl_snapshot_entries entry_row
      ON entry_row.season_id = publication.season_id
     AND entry_row.event_id = publication.event_id
     AND entry_row.revision = publication.revision
    WHERE publication.season_id = 2026
      AND publication.event_id = 1
      AND publication.revision = (SELECT revision FROM graphql_my_fpl_revision)
      AND publication.active
      AND entry_row.entry_id = 1
      AND EXISTS (
        SELECT 1
        FROM competition.my_fpl_snapshot_tournament_rows row_data
        WHERE row_data.season_id = publication.season_id
          AND row_data.event_id = publication.event_id
          AND row_data.revision = publication.revision
          AND row_data.tournament_id = 2147483000
          AND row_data.entry_id = entry_row.entry_id
      )
      AND EXISTS (
        SELECT 1
        FROM competition.my_fpl_snapshot_tournament_aggregates aggregate_data
        WHERE aggregate_data.season_id = publication.season_id
          AND aggregate_data.event_id = publication.event_id
          AND aggregate_data.revision = publication.revision
          AND aggregate_data.tournament_id = 2147483000
      )
  ) THEN
    RAISE EXCEPTION 'expected complete active My FPL reader visibility fixture';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM competition.my_fpl_snapshot_publication_outbox outbox
    JOIN competition.my_fpl_snapshot_publications publication
      ON publication.season_id = outbox.season_id
     AND publication.event_id = outbox.event_id
     AND publication.revision = outbox.revision
    WHERE publication.season_id = 2026
      AND publication.event_id = 1
      AND publication.revision = (SELECT revision FROM graphql_my_fpl_revision)
      AND publication.active
      AND outbox.status = 'PENDING'
      AND outbox.delivered_at IS NULL
      AND outbox.manifest->>'contentSha256' = publication.content_sha256
  ) THEN
    RAISE EXCEPTION 'expected requeued My FPL publication receipt with current manifest';
  END IF;
  IF (
    SELECT count(*)
    FROM competition.my_fpl_snapshot_entries
    WHERE season_id = 2026 AND event_id = 1
      AND revision = (SELECT revision FROM graphql_my_fpl_revision)
  ) <> 1 OR (
    SELECT count(*)
    FROM competition.my_fpl_snapshot_tournament_rows
    WHERE season_id = 2026 AND event_id = 1
      AND revision = (SELECT revision FROM graphql_my_fpl_revision)
  ) <> 2 OR (
    SELECT count(*)
    FROM competition.my_fpl_snapshot_tournament_aggregates
    WHERE season_id = 2026 AND event_id = 1
      AND revision = (SELECT revision FROM graphql_my_fpl_revision)
  ) <> 2 OR (
    SELECT count(*)
    FROM competition.tournament_entries
    WHERE season_id = 2026 AND tournament_id = 2147483000
  ) <> 1 OR (
    SELECT count(*)
    FROM competition.public_league_trends
    WHERE season_id = 2026 AND tournament_id = 2147483000 AND enabled
  ) <> 1 OR (
    SELECT count(*)
    FROM reporting.tournament_selection_stat_publications
    WHERE season_id = 2026 AND tournament_id = 2147483000 AND event_id = 1
      AND revision = (SELECT revision FROM graphql_trends_revision WHERE event_id = 1) AND is_active
  ) <> 0 OR (
    SELECT count(*)
    FROM reporting.tournament_selection_stat_publications
    WHERE season_id = 2026 AND tournament_id = 2147483000 AND event_id = 2
      AND revision = (SELECT revision FROM graphql_trends_revision WHERE event_id = 2) AND is_active
  ) <> 1 OR (
    SELECT count(*)
    FROM reporting.tournament_selection_stat_rows trend_row
    JOIN reporting.tournament_selection_stat_publications publication
      ON publication.publication_id = trend_row.publication_id
    WHERE publication.season_id = 2026
      AND publication.tournament_id = 2147483000
      AND publication.event_id = 2
      AND publication.revision = (
        SELECT revision FROM graphql_trends_revision WHERE event_id = 2
      )
  ) <> 15 OR (
    SELECT count(*)
    FROM competition.entry_leagues
    WHERE season_id = 2026 AND entry_id = 1
  ) <> 1 OR (
    SELECT count(*)
    FROM competition.entry_leagues
    WHERE season_id = 2026 AND entry_id = 1 AND league_id = 2 AND league_type = 'classic'
  ) <> 1 OR (
    SELECT count(*)
    FROM competition.tournament_entries
    WHERE season_id = 2026 AND tournament_id = 2147483001
  ) <> 1 THEN
    RAISE EXCEPTION 'expected exact My FPL fixture child sets';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM reporting.tournament_selection_stat_publications
    WHERE season_id = 2026 AND tournament_id = 2147483000 AND event_id = 1
      AND revision = (SELECT revision FROM graphql_trends_revision WHERE event_id = 1)
      AND publication_state = 'READY'
  ) THEN
    RAISE EXCEPTION 'ineligible trend roster must not produce a READY publication';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM reporting.tournament_selection_stat_publications publication
    WHERE publication.season_id = 2026
      AND publication.tournament_id = 2147483000
      AND publication.event_id = 1
      AND publication.revision = (
        SELECT revision FROM graphql_trends_revision WHERE event_id = 1
      )
      AND publication.publication_state = 'COLLECTING'
      AND NOT publication.is_active
      AND publication.expected_entries = 0
      AND publication.complete_pick_entries = 0
      AND publication.transfer_checkpoint_entries = 0
  ) THEN
    RAISE EXCEPTION 'ineligible trend fixture must remain an inactive collecting publication';
  END IF;
  IF (
    SELECT count(*)
    FROM reporting.tournament_selection_stat_rows trend_row
    JOIN reporting.tournament_selection_stat_publications publication
      ON publication.publication_id = trend_row.publication_id
    WHERE publication.season_id = 2026
      AND publication.tournament_id = 2147483000
      AND publication.event_id = 1
      AND publication.revision = (
        SELECT revision FROM graphql_trends_revision WHERE event_id = 1
      )
  ) <> 0 THEN
    RAISE EXCEPTION 'collecting trend fixture must not retain rows';
  END IF;
  IF (
    SELECT content_sha256
    FROM competition.my_fpl_snapshot_publications
    WHERE season_id = 2026 AND event_id = 1
      AND revision = (SELECT revision FROM graphql_my_fpl_revision)
  ) = repeat('0', 64) THEN
    RAISE EXCEPTION 'My FPL content hash must be derived from child payloads';
  END IF;
END
$$;

-- Commit only after every publication, delivery receipt, and consumer-facing
-- assertion above has succeeded. The caller must not wrap this file in a
-- rollback transaction: the fixture is deliberately atomic and durable.
COMMIT;
