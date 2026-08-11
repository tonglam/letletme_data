-- Canonicalize bridge, publication, and operational control metadata without
-- rewriting any unrelated business row.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_advisory_xact_lock(912883475);

DO $canonical_contract_precondition$
DECLARE
  active_core_publication_count bigint;
  active_current_core_publication_count bigint;
  retired_singleton_count bigint;
  value_seed_count bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'bridge' AND table_name = 'entity_links'
      AND column_name = 'rule_version'
  ) OR EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'bridge' AND table_name = 'entity_links'
      AND column_name = 'rule_id'
  ) THEN
    RAISE EXCEPTION 'bridge.entity_links is not in the expected pre-canonical state';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'bridge' AND table_name = 'match_links'
      AND column_name = 'rule_version'
  ) OR EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'bridge' AND table_name = 'match_links'
      AND column_name = 'rule_id'
  ) THEN
    RAISE EXCEPTION 'bridge.match_links is not in the expected pre-canonical state';
  END IF;

  IF EXISTS (
    SELECT 1 FROM bridge.entity_links
    WHERE rule_version !~ '^understat-fpl-[a-z0-9-]+(-v[0-9]+)?$'
      OR evidence IS NULL
      OR jsonb_typeof(evidence) <> 'object'
      OR (
        evidence ? 'ruleVersion'
        AND evidence ->> 'ruleVersion' IS DISTINCT FROM rule_version
      )
      OR (
        evidence ? 'ruleId'
        AND evidence ->> 'ruleId' IS DISTINCT FROM regexp_replace(rule_version, '-v[0-9]+$', '')
      )
  ) THEN
    RAISE EXCEPTION 'unexpected bridge.entity_links rule or evidence population';
  END IF;

  IF EXISTS (
    SELECT 1 FROM bridge.match_links
    WHERE rule_version !~ '^understat-fpl-[a-z0-9-]+(-v[0-9]+)?$'
      OR evidence IS NULL
      OR jsonb_typeof(evidence) <> 'object'
      OR (
        evidence ? 'ruleVersion'
        AND evidence ->> 'ruleVersion' IS DISTINCT FROM rule_version
      )
      OR (
        evidence ? 'ruleId'
        AND evidence ->> 'ruleId' IS DISTINCT FROM regexp_replace(rule_version, '-v[0-9]+$', '')
      )
  ) THEN
    RAISE EXCEPTION 'unexpected bridge.match_links rule or evidence population';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM competition.tournaments tournament
    WHERE (
      SELECT count(*)
      FROM competition.tournament_entries entry_row
      WHERE entry_row.season_id = tournament.season_id
        AND entry_row.tournament_id = tournament.tournament_id
    ) <> tournament.total_team_num
  ) THEN
    RAISE EXCEPTION 'tournament roster cardinality requires explicit repair';
  END IF;

  IF EXISTS (
    SELECT 1 FROM ops.sync_runs
    WHERE (
      metadata ? 'legacy_cache_revision'
      AND jsonb_typeof(metadata -> 'legacy_cache_revision') <> 'string'
    ) OR (
      metadata ? 'legacy_publication_skip_reason'
      AND jsonb_typeof(metadata -> 'legacy_publication_skip_reason') <> 'string'
    )
  ) THEN
    RAISE EXCEPTION 'unexpected retired sync-run metadata population';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ops.sync_items item
    JOIN ops.sync_runs run ON run.run_id = item.run_id
    WHERE item.normalized_payload ?| ARRAY['version', 'schemaVersion', 'planVersion', 'engineVersion']
      AND (
        run.provider <> 'understat'
        OR run.status NOT IN ('failed', 'completed', 'published', 'skipped')
        OR item.status NOT IN ('completed', 'failed', 'skipped')
      )
  ) THEN
    RAISE EXCEPTION 'non-terminal sync-item payloads still require explicit canonicalization';
  END IF;

  SELECT count(*) INTO value_seed_count
  FROM fpl.player_market_snapshots
  WHERE snapshot_source = 'legacy_value_seed';

  IF value_seed_count NOT IN (0, 564) OR EXISTS (
    SELECT 1 FROM fpl.player_market_snapshots
    WHERE snapshot_source NOT IN ('upstream', 'legacy_value_seed')
  ) THEN
    RAISE EXCEPTION 'unexpected player market snapshot source';
  END IF;

  IF EXISTS (
    SELECT 1 FROM ops.dataset_publications
    WHERE jsonb_typeof(manifest) <> 'object'
      OR dataset NOT IN ('fpl:core', 'fpl:live')
      OR season_id IS NULL
      OR (dataset = 'fpl:core' AND event_id IS NOT NULL)
      OR (dataset = 'fpl:live' AND event_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'dataset publication history contains an invalid scope or manifest';
  END IF;

  SELECT count(*) INTO active_current_core_publication_count
  FROM ops.dataset_publications publication
  JOIN fpl.seasons season ON season.season_id = publication.season_id
  WHERE publication.dataset = 'fpl:core'
    AND publication.event_id IS NULL
    AND publication.status = 'active'
    AND season.is_current;

  SELECT count(*) INTO active_core_publication_count
  FROM ops.dataset_publications
  WHERE dataset = 'fpl:core'
    AND event_id IS NULL
    AND status = 'active';

  SELECT count(*) INTO retired_singleton_count
  FROM ops.dataset_publications
  WHERE status = 'retired'
    AND source_run_id IS NULL
    AND manifest ? 'legacy_singleton_id';

  IF active_current_core_publication_count <> 1
    OR active_core_publication_count <> 1
    OR retired_singleton_count NOT IN (0, 1)
    OR EXISTS (
      SELECT 1 FROM ops.dataset_publications
      WHERE manifest ? 'legacy_singleton_id'
        AND manifest <> jsonb_build_object('state', 'retired', 'legacy_singleton_id', 1)
    )
  THEN
    RAISE EXCEPTION 'unexpected dataset publication population';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ops.dataset_publications publication
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(publication.manifest -> 'items') = 'array'
          THEN publication.manifest -> 'items'
        ELSE '[]'::jsonb
      END
    ) item
    WHERE coalesce(item ->> 'key', '') !~ '^llm:v[0-9]+:data:'
  ) THEN
    RAISE EXCEPTION 'unexpected pre-canonical publication item key';
  END IF;
END
$canonical_contract_precondition$;

SET LOCAL ROLE letletme_data_owner;

-- Staged Understat payloads are operational retry state, not historical data.
-- Terminal rows are no longer read by the worker; clear their retired envelope
-- and hash so the canonical reader never needs a compatibility path. Any
-- non-terminal legacy envelope was rejected above before this mutation.
UPDATE ops.sync_items item
SET
  normalized_payload = NULL,
  source_hash = NULL,
  updated_at = now()
FROM ops.sync_runs run
WHERE run.run_id = item.run_id
  AND run.provider = 'understat'
  AND run.status IN ('failed', 'completed', 'published', 'skipped')
  AND item.status IN ('completed', 'failed', 'skipped')
  AND item.normalized_payload ?| ARRAY['version', 'schemaVersion', 'planVersion', 'engineVersion'];

ALTER TABLE bridge.entity_links RENAME COLUMN rule_version TO rule_id;
ALTER TABLE bridge.match_links RENAME COLUMN rule_version TO rule_id;
ALTER TABLE bridge.entity_links
  RENAME CONSTRAINT bridge_entity_links_fields_nonempty
  TO bridge_entity_links_required_fields_nonempty;
ALTER TABLE bridge.match_links
  RENAME CONSTRAINT bridge_match_links_fields_nonempty
  TO bridge_match_links_required_fields_nonempty;

UPDATE bridge.entity_links
SET
  rule_id = regexp_replace(rule_id, '-v[0-9]+$', ''),
  evidence = (evidence - 'ruleVersion')
    || jsonb_build_object('ruleId', regexp_replace(rule_id, '-v[0-9]+$', ''));

UPDATE bridge.match_links
SET
  rule_id = regexp_replace(rule_id, '-v[0-9]+$', ''),
  evidence = (evidence - 'ruleVersion')
    || jsonb_build_object('ruleId', regexp_replace(rule_id, '-v[0-9]+$', ''));

UPDATE ops.sync_runs
SET metadata = metadata - ARRAY[
  'legacy_cache_revision',
  'legacy_publication_skip_reason'
]
WHERE metadata ?| ARRAY[
  'legacy_cache_revision',
  'legacy_publication_skip_reason'
];

ALTER TABLE fpl.player_market_snapshots
  DROP CONSTRAINT player_market_snapshots_source_valid;

UPDATE fpl.player_market_snapshots
SET snapshot_source = 'value_seed'
WHERE snapshot_source = 'legacy_value_seed';

ALTER TABLE fpl.player_market_snapshots
  ADD CONSTRAINT player_market_snapshots_source_valid CHECK (
    (
      snapshot_source = 'upstream'
      AND source_snapshot_id IS NOT NULL
      AND source_value_id IS NULL
    ) OR (
      snapshot_source = 'value_seed'
      AND source_snapshot_id IS NULL
      AND source_value_id IS NOT NULL
      AND source_event_id IS NOT NULL
    )
  );

DELETE FROM ops.dataset_publications
WHERE status = 'retired'
  AND source_run_id IS NULL
  AND manifest = jsonb_build_object('state', 'retired', 'legacy_singleton_id', 1);

UPDATE ops.dataset_publications publication
SET
  manifest = jsonb_build_object(
    'dataset', publication.dataset,
    'seasonCode', season.season_code,
    'eventId', publication.event_id,
    'revision', publication.revision,
    'publicationId', publication.publication_id::text,
    'sourceCheckedAt', coalesce(
      publication.activated_at,
      publication.retired_at,
      publication.created_at
    ),
    'publishedAt', coalesce(
      publication.activated_at,
      publication.retired_at,
      publication.created_at
    ),
    'state', CASE
      WHEN publication.dataset = 'fpl:core' THEN 'active'
      WHEN publication.manifest ->> 'state' IN ('scheduled', 'live', 'settled')
        THEN publication.manifest ->> 'state'
      WHEN publication.status = 'active' THEN 'live'
      ELSE 'settled'
    END,
    'items', CASE
      WHEN jsonb_typeof(publication.manifest -> 'items') = 'array' THEN (
        SELECT coalesce(
          jsonb_agg(
            jsonb_build_object(
              'name', item.value -> 'name',
              'key', regexp_replace(
                item.value ->> 'key',
                '^llm:v[0-9]+:data:',
                'llm:data:'
              ),
              'type', item.value -> 'type',
              'count', item.value -> 'count',
              'bytes', item.value -> 'bytes',
              'sha256', item.value -> 'sha256'
            )
            ORDER BY item.ordinality
          ),
          '[]'::jsonb
        )
        FROM jsonb_array_elements(publication.manifest -> 'items')
          WITH ORDINALITY AS item(value, ordinality)
      )
      ELSE '[]'::jsonb
    END
  ),
  updated_at = now()
FROM fpl.seasons season
WHERE season.season_id = publication.season_id;

RESET ROLE;

DO $canonical_contract_postcondition$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'bridge' AND table_name IN ('entity_links', 'match_links')
      AND column_name = 'rule_version'
  ) OR (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'bridge' AND table_name IN ('entity_links', 'match_links')
      AND column_name = 'rule_id'
  ) <> 2 THEN
    RAISE EXCEPTION 'bridge rule column canonicalization failed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM bridge.entity_links
    WHERE rule_id !~ '^understat-fpl(-[a-z0-9]+(-[a-z0-9]+)*)?$'
      OR rule_id ~ '-v[0-9]+$'
      OR evidence ? 'ruleVersion'
      OR evidence ->> 'ruleId' IS DISTINCT FROM rule_id
  ) OR EXISTS (
    SELECT 1 FROM bridge.match_links
    WHERE rule_id !~ '^understat-fpl(-[a-z0-9]+(-[a-z0-9]+)*)?$'
      OR rule_id ~ '-v[0-9]+$'
      OR evidence ? 'ruleVersion'
      OR evidence ->> 'ruleId' IS DISTINCT FROM rule_id
  ) THEN
    RAISE EXCEPTION 'bridge rule identifiers are not canonical';
  END IF;

  IF EXISTS (
    SELECT 1 FROM ops.sync_runs
    WHERE metadata ?| ARRAY[
      'legacy_cache_revision',
      'legacy_publication_skip_reason'
    ]
  ) OR EXISTS (
    SELECT 1 FROM ops.sync_items
    WHERE normalized_payload ?| ARRAY['version', 'schemaVersion', 'planVersion', 'engineVersion']
  ) THEN
    RAISE EXCEPTION 'operational control metadata is not canonical';
  END IF;

  IF EXISTS (
    SELECT 1 FROM ops.dataset_publications
    WHERE NOT manifest ?& ARRAY[
      'dataset', 'seasonCode', 'eventId', 'revision', 'publicationId',
      'sourceCheckedAt', 'publishedAt', 'state', 'items'
    ] OR manifest - ARRAY[
      'dataset', 'seasonCode', 'eventId', 'revision', 'publicationId',
      'sourceCheckedAt', 'publishedAt', 'state', 'items'
    ] <> '{}'::jsonb
  ) THEN
    RAISE EXCEPTION 'publication manifest canonicalization failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ops.dataset_publications publication
    CROSS JOIN LATERAL jsonb_array_elements(publication.manifest -> 'items') item
    WHERE coalesce(item ->> 'key', '') !~ '^llm:data:'
  ) THEN
    RAISE EXCEPTION 'publication item key canonicalization failed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM fpl.player_market_snapshots
    WHERE snapshot_source NOT IN ('upstream', 'value_seed')
  ) THEN
    RAISE EXCEPTION 'player market snapshot sources are not canonical';
  END IF;
END
$canonical_contract_postcondition$;
