-- Populate reporting MVs once and prepare, but do not activate, the first v3 dataset revision.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL ROLE letletme_data_owner;

REFRESH MATERIALIZED VIEW reporting.tournament_selection_stats;
REFRESH MATERIALIZED VIEW reporting.tournament_entry_event_summaries;

ANALYZE reporting.tournament_selection_stats;
ANALYZE reporting.tournament_entry_event_summaries;

WITH current_season AS (
  SELECT season_id, season_code
  FROM fpl.seasons
  WHERE is_current
), publication_manifest AS (
  SELECT jsonb_build_object(
    'schemaVersion', 'v3',
    'planVersion', '3.1.1',
    'season', season.season_code,
    'state', 'prepared',
    'counts', jsonb_build_object(
      'events', (SELECT count(*) FROM fpl.events event WHERE event.season_id = season.season_id),
      'teams', (SELECT count(*) FROM fpl.teams team WHERE team.season_id = season.season_id),
      'players', (SELECT count(*) FROM fpl.players player WHERE player.season_id = season.season_id),
      'fixtures', (SELECT count(*) FROM fpl.fixtures fixture WHERE fixture.season_id = season.season_id),
      'playerEventSnapshots', (
        SELECT count(*) FROM fpl.player_event_snapshots snapshot
        WHERE snapshot.season_id = season.season_id
      ),
      'playerGameweekStats', (
        SELECT count(*) FROM fpl.player_gameweek_stats stats
        WHERE stats.season_id = season.season_id
      ),
      'playerMarketSnapshots', (
        SELECT count(*) FROM fpl.player_market_snapshots market
        WHERE market.season_id = season.season_id
      )
    )
  ) AS manifest
  FROM current_season season
)
INSERT INTO ops.dataset_publications (
  publication_id,
  dataset,
  season_id,
  event_id,
  status,
  manifest,
  created_at,
  updated_at
)
SELECT
  md5('letletme:v3:fpl:core:' || season.season_code || ':initial')::uuid,
  'fpl:core',
  season.season_id,
  NULL,
  'staging',
  publication.manifest,
  now(),
  now()
FROM current_season season
CROSS JOIN publication_manifest publication
ON CONFLICT (publication_id) DO UPDATE SET
  manifest = EXCLUDED.manifest,
  updated_at = now()
WHERE ops.dataset_publications.status = 'staging';

DO $prepared_publication_contract$
DECLARE
  prepared_count integer;
  unpopulated_mv_count integer;
  missing_unique_mv_index_count integer;
BEGIN
  SELECT count(*) INTO prepared_count
  FROM ops.dataset_publications publication
  JOIN fpl.seasons season ON season.season_id = publication.season_id AND season.is_current
  WHERE publication.dataset = 'fpl:core'
    AND publication.status = 'staging'
    AND publication.manifest ->> 'schemaVersion' = 'v3'
    AND publication.manifest ->> 'state' = 'prepared';

  IF prepared_count <> 1 THEN
    RAISE EXCEPTION 'expected one prepared current-season v3 core publication, found %', prepared_count;
  END IF;

  SELECT count(*) INTO unpopulated_mv_count
  FROM pg_class relation_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
  WHERE namespace_row.nspname = 'reporting'
    AND relation_row.relname IN (
      'tournament_selection_stats',
      'tournament_entry_event_summaries'
    )
    AND relation_row.relkind = 'm'
    AND NOT relation_row.relispopulated;

  IF unpopulated_mv_count <> 0 THEN
    RAISE EXCEPTION 'unpopulated reporting MVs after initial refresh: %', unpopulated_mv_count;
  END IF;

  SELECT count(*) INTO missing_unique_mv_index_count
  FROM pg_class relation_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
  WHERE namespace_row.nspname = 'reporting'
    AND relation_row.relname IN (
      'tournament_selection_stats',
      'tournament_entry_event_summaries'
    )
    AND relation_row.relkind = 'm'
    AND NOT EXISTS (
      SELECT 1
      FROM pg_index index_row
      WHERE index_row.indrelid = relation_row.oid
        AND index_row.indisunique
        AND index_row.indisvalid
        AND index_row.indpred IS NULL
    );

  IF missing_unique_mv_index_count <> 0 THEN
    RAISE EXCEPTION 'reporting MVs without a valid full unique index: %',
      missing_unique_mv_index_count;
  END IF;
END
$prepared_publication_contract$;

INSERT INTO ops.migration_objects (
  run_id,
  check_name,
  source_object,
  target_object,
  query_sha256,
  source_row_count,
  target_row_count,
  source_hash,
  target_hash,
  failed_count,
  sample_failed_keys,
  status
)
SELECT
  run.run_id,
  '0089_prepare_v3_publication',
  'fpl.current_core',
  'ops.dataset_publications',
  encode(sha256(convert_to('0089_prepare_v3_publication_v1', 'UTF8')), 'hex'),
  NULL,
  1,
  NULL,
  NULL,
  0,
  '[]'::jsonb,
  'passed'
FROM ops.migration_runs run
WHERE run.run_id = 'v3-20260808T160008Z-b9eddc0'
ON CONFLICT (run_id, check_name, source_object, target_object) DO UPDATE SET
  query_sha256 = EXCLUDED.query_sha256,
  target_row_count = EXCLUDED.target_row_count,
  failed_count = EXCLUDED.failed_count,
  sample_failed_keys = EXCLUDED.sample_failed_keys,
  status = EXCLUDED.status,
  executed_at = now();

RESET ROLE;
