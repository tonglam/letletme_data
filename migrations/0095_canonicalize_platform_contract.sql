-- Canonicalize the bridge and publication contracts without rewriting any
-- unrelated business row.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_advisory_xact_lock(912883475);

DO $canonical_contract_precondition$
DECLARE
  active_publication_count bigint;
  retired_singleton_count bigint;
  player_link_count bigint;
  versioned_manifest_count bigint;
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

  SELECT count(*) INTO player_link_count FROM bridge.entity_links;
  IF player_link_count NOT IN (0, 2192) OR EXISTS (
    SELECT 1 FROM bridge.entity_links
    WHERE rule_version <> 'understat-fpl-player-name-v3'
  ) THEN
    RAISE EXCEPTION 'unexpected bridge.entity_links rule population';
  END IF;

  IF EXISTS (SELECT 1 FROM bridge.match_links) THEN
    RAISE EXCEPTION 'unexpected bridge.match_links rows require an explicit rule migration';
  END IF;

  IF EXISTS (
    SELECT 1 FROM fpl.player_market_snapshots
    WHERE snapshot_source NOT IN ('upstream', 'legacy_value_seed')
  ) THEN
    RAISE EXCEPTION 'unexpected player market snapshot source';
  END IF;

  IF EXISTS (
    SELECT 1 FROM ops.dataset_publications
    WHERE (manifest ? 'schemaVersion' AND manifest ->> 'schemaVersion' <> 'v3')
       OR (manifest ? 'planVersion' AND manifest ->> 'planVersion' <> '3.2.5')
  ) THEN
    RAISE EXCEPTION 'unexpected publication version metadata';
  END IF;

  SELECT count(*) INTO versioned_manifest_count
  FROM ops.dataset_publications
  WHERE manifest ? 'schemaVersion' OR manifest ? 'planVersion';

  IF versioned_manifest_count NOT IN (0, 1) THEN
    RAISE EXCEPTION 'unexpected number of versioned publication manifests: %',
      versioned_manifest_count;
  END IF;

  SELECT count(*) INTO active_publication_count
  FROM ops.dataset_publications
  WHERE dataset = 'fpl:core'
    AND event_id IS NULL
    AND status = 'active'
    AND source_run_id IS NULL;

  SELECT count(*) INTO retired_singleton_count
  FROM ops.dataset_publications
  WHERE status = 'retired'
    AND source_run_id IS NULL
    AND manifest ? 'legacy_singleton_id';

  IF active_publication_count <> 1
    OR retired_singleton_count NOT IN (0, 1)
    OR (SELECT count(*) FROM ops.dataset_publications)
      <> active_publication_count + retired_singleton_count
    OR EXISTS (
      SELECT 1 FROM ops.dataset_publications
      WHERE manifest ? 'legacy_singleton_id'
        AND manifest <> jsonb_build_object('state', 'retired', 'legacy_singleton_id', 1)
    )
  THEN
    RAISE EXCEPTION 'unexpected dataset publication population';
  END IF;
END
$canonical_contract_precondition$;

SET LOCAL ROLE letletme_data_owner;

ALTER TABLE bridge.entity_links RENAME COLUMN rule_version TO rule_id;
ALTER TABLE bridge.match_links RENAME COLUMN rule_version TO rule_id;
ALTER TABLE bridge.entity_links
  RENAME CONSTRAINT bridge_entity_links_fields_nonempty
  TO bridge_entity_links_required_fields_nonempty;
ALTER TABLE bridge.match_links
  RENAME CONSTRAINT bridge_match_links_fields_nonempty
  TO bridge_match_links_required_fields_nonempty;

UPDATE bridge.entity_links
SET rule_id = 'understat-fpl-player-name'
WHERE rule_id = 'understat-fpl-player-name-v3';

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
    'sourceCheckedAt', coalesce(publication.activated_at, publication.created_at),
    'publishedAt', coalesce(publication.activated_at, publication.created_at),
    'state', 'active',
    'items', jsonb_build_array()
  ),
  updated_at = now()
FROM fpl.seasons season
WHERE season.season_id = publication.season_id
  AND publication.status = 'active';

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
    WHERE rule_id <> 'understat-fpl-player-name'
  ) OR EXISTS (
    SELECT 1 FROM bridge.match_links WHERE btrim(rule_id) = ''
  ) THEN
    RAISE EXCEPTION 'bridge rule identifiers are not canonical';
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
    RAISE EXCEPTION 'publication manifests are not canonical';
  END IF;

  IF EXISTS (
    SELECT 1 FROM fpl.player_market_snapshots
    WHERE snapshot_source NOT IN ('upstream', 'value_seed')
  ) THEN
    RAISE EXCEPTION 'player market snapshot sources are not canonical';
  END IF;
END
$canonical_contract_postcondition$;
