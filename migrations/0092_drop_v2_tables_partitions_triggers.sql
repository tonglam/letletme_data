-- Approval-gated removal of the exact v2 physical/sequence/enum allowlist.
-- The two legacy migration ledgers remain until 0093.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

SELECT pg_advisory_xact_lock(912883473);

DO $legacy_drop_approval$
DECLARE
  approval text := current_setting('letletme.v3_legacy_drop_approval', true);
  approved_run_count bigint;
BEGIN
  SELECT count(*) INTO approved_run_count
  FROM ops.migration_runs run
  WHERE run.status = 'activated'
    AND approval = 'APPROVE_V3_LEGACY_DROP ' || run.run_id
    AND run.metadata ->> 'legacyDropPhase' = 'reporting_and_rpcs_removed';

  IF approved_run_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = '0092 requires exact approval and a completed 0091 phase';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM ops.migration_objects
    WHERE check_name = '0091_drop_v2_reporting_and_rpcs'
      AND status = 'passed'
  ) THEN
    RAISE EXCEPTION '0092 cannot find passing 0091 evidence';
  END IF;
END
$legacy_drop_approval$;

DO $assume_v2_frozen_owner$
BEGIN
  EXECUTE format('GRANT letletme_v2_frozen_owner TO %I', session_user);
END
$assume_v2_frozen_owner$;

CREATE TEMPORARY TABLE v3_legacy_physical_relations (
  relation_name name PRIMARY KEY
) ON COMMIT DROP;

CREATE TEMPORARY TABLE v3_legacy_drop_roots (
  relation_name name PRIMARY KEY
) ON COMMIT DROP;

WITH families(relation_name) AS (
  VALUES
    ('event_fixtures'),
    ('event_live_explains'),
    ('event_live_summaries'),
    ('event_lives'),
    ('events'),
    ('fpl_player_fixture_stats'),
    ('phases'),
    ('player_market_snapshots'),
    ('player_stats'),
    ('player_values'),
    ('players'),
    ('teams')
), seasons(season_code) AS (
  VALUES
    ('1617'), ('1718'), ('1819'), ('1920'), ('2021'), ('2122'),
    ('2223'), ('2324'), ('2425'), ('2526'), ('2627')
)
INSERT INTO v3_legacy_physical_relations (relation_name)
SELECT relation_name::name FROM families
UNION ALL
SELECT (relation_name || '_history')::name FROM families
UNION ALL
SELECT (relation_name || '_' || season_code)::name FROM families CROSS JOIN seasons;

WITH families(relation_name) AS (
  VALUES
    ('event_fixtures'),
    ('event_live_explains'),
    ('event_live_summaries'),
    ('event_lives'),
    ('events'),
    ('fpl_player_fixture_stats'),
    ('phases'),
    ('player_market_snapshots'),
    ('player_stats'),
    ('player_values'),
    ('players'),
    ('teams')
)
INSERT INTO v3_legacy_drop_roots (relation_name)
SELECT relation_name::name FROM families
UNION ALL
SELECT (relation_name || '_history')::name FROM families;

INSERT INTO v3_legacy_physical_relations (relation_name)
VALUES
  ('core_snapshot_authority'),
  ('entry_event_cup_results'),
  ('entry_event_picks'),
  ('entry_event_results'),
  ('entry_event_transfers'),
  ('entry_history_infos'),
  ('entry_infos'),
  ('entry_league_infos'),
  ('fpl_season_archive_items'),
  ('fpl_season_archives'),
  ('graphql_schema_migrations'),
  ('league_event_results'),
  ('provider_entity_aliases'),
  ('provider_entity_links'),
  ('provider_match_links'),
  ('sql_migrations_v2'),
  ('tournament_battle_group_results'),
  ('tournament_entries'),
  ('tournament_groups'),
  ('tournament_infos'),
  ('tournament_knockout_results'),
  ('tournament_knockouts'),
  ('tournament_points_group_results'),
  ('tournament_selection_stats'),
  ('understat_matches'),
  ('understat_player_match_stats'),
  ('understat_player_seasons'),
  ('understat_player_team_seasons'),
  ('understat_players'),
  ('understat_seasons'),
  ('understat_sync_items'),
  ('understat_sync_runs'),
  ('understat_team_match_stats'),
  ('understat_team_seasons'),
  ('understat_team_stat_splits'),
  ('understat_teams');

INSERT INTO v3_legacy_physical_relations (relation_name)
SELECT 'public_league_trends_catalog'::name
WHERE to_regclass('public.public_league_trends_catalog') IS NOT NULL;

GRANT SELECT ON v3_legacy_physical_relations TO letletme_data_owner;

INSERT INTO v3_legacy_drop_roots (relation_name)
VALUES
  ('core_snapshot_authority'),
  ('entry_event_cup_results'),
  ('entry_event_picks'),
  ('entry_event_results'),
  ('entry_event_transfers'),
  ('entry_history_infos'),
  ('entry_infos'),
  ('entry_league_infos'),
  ('fpl_season_archive_items'),
  ('fpl_season_archives'),
  ('league_event_results'),
  ('provider_entity_aliases'),
  ('provider_entity_links'),
  ('provider_match_links'),
  ('tournament_battle_group_results'),
  ('tournament_entries'),
  ('tournament_groups'),
  ('tournament_infos'),
  ('tournament_knockout_results'),
  ('tournament_knockouts'),
  ('tournament_points_group_results'),
  ('tournament_selection_stats'),
  ('understat_matches'),
  ('understat_player_match_stats'),
  ('understat_player_seasons'),
  ('understat_player_team_seasons'),
  ('understat_players'),
  ('understat_seasons'),
  ('understat_sync_items'),
  ('understat_sync_runs'),
  ('understat_team_match_stats'),
  ('understat_team_seasons'),
  ('understat_team_stat_splits'),
  ('understat_teams');

INSERT INTO v3_legacy_drop_roots (relation_name)
SELECT 'public_league_trends_catalog'::name
WHERE to_regclass('public.public_league_trends_catalog') IS NOT NULL;

CREATE TEMPORARY TABLE v3_legacy_sequences (
  relation_name name PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO v3_legacy_sequences (relation_name)
VALUES
  ('core_snapshot_revision_seq'),
  ('entry_event_cup_results_id_seq'),
  ('entry_event_picks_id_seq'),
  ('entry_event_results_id_seq'),
  ('entry_event_transfers_id_seq'),
  ('entry_history_infos_id_seq'),
  ('entry_league_infos_id_seq'),
  ('event_live_explains_id_seq'),
  ('event_live_summaries_id_seq'),
  ('event_lives_id_seq'),
  ('fpl_player_fixture_stats_id_seq'),
  ('league_event_results_id_seq'),
  ('player_market_snapshots_id_seq'),
  ('player_stats_id_seq'),
  ('player_values_id_seq'),
  ('tournament_battle_group_results_id_seq'),
  ('tournament_entries_id_seq'),
  ('tournament_groups_id_seq'),
  ('tournament_infos_id_seq'),
  ('tournament_knockout_results_id_seq'),
  ('tournament_knockouts_id_seq'),
  ('tournament_points_group_results_id_seq');

CREATE TEMPORARY TABLE v3_legacy_enum_types (
  type_name name PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO v3_legacy_enum_types (type_name)
VALUES
  ('chip'),
  ('cup_result'),
  ('fpl_season_archive_status'),
  ('group_mode'),
  ('knockout_mode'),
  ('league_type'),
  ('provider_entity_type'),
  ('provider_link_status'),
  ('tournament_mode'),
  ('tournament_roster_mode'),
  ('tournament_setup_phase'),
  ('tournament_setup_status'),
  ('tournament_state'),
  ('understat_lane'),
  ('understat_season_state'),
  ('understat_sync_item_status'),
  ('understat_sync_mode'),
  ('understat_sync_run_status'),
  ('understat_sync_trigger'),
  ('value_change_type');

DO $legacy_physical_scope$
DECLARE
  missing_relations text;
  uncovered_relations text;
  unexpected_relations text;
  actual_enum_types text[];
  actual_sequences text[];
BEGIN
  SELECT string_agg(expected.relation_name::text, ', ' ORDER BY expected.relation_name)
  INTO missing_relations
  FROM v3_legacy_physical_relations expected
  LEFT JOIN pg_class relation_row
    ON relation_row.relnamespace = 'public'::regnamespace
   AND relation_row.relname = expected.relation_name
   AND relation_row.relkind IN ('r', 'p')
  WHERE relation_row.oid IS NULL;

  SELECT string_agg(relation_row.relname, ', ' ORDER BY relation_row.relname)
  INTO unexpected_relations
  FROM pg_class relation_row
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND relation_row.relkind IN ('r', 'p')
    AND NOT EXISTS (
      SELECT 1 FROM v3_legacy_physical_relations expected
      WHERE expected.relation_name = relation_row.relname
    );

  SELECT string_agg(expected.relation_name::text, ', ' ORDER BY expected.relation_name)
  INTO uncovered_relations
  FROM v3_legacy_physical_relations expected
  JOIN pg_class relation_row
    ON relation_row.relnamespace = 'public'::regnamespace
   AND relation_row.relname = expected.relation_name
  WHERE expected.relation_name NOT IN ('graphql_schema_migrations', 'sql_migrations_v2')
    AND NOT EXISTS (
      SELECT 1 FROM v3_legacy_drop_roots root
      WHERE root.relation_name = expected.relation_name
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_inherits inheritance
      JOIN pg_class parent_row ON parent_row.oid = inheritance.inhparent
      JOIN v3_legacy_drop_roots root ON root.relation_name = parent_row.relname
      WHERE inheritance.inhrelid = relation_row.oid
        AND parent_row.relnamespace = 'public'::regnamespace
    );

  IF missing_relations IS NOT NULL OR unexpected_relations IS NOT NULL
     OR uncovered_relations IS NOT NULL THEN
    RAISE EXCEPTION '0092 physical scope mismatch: missing=[%], unexpected=[%], uncovered=[%]',
      COALESCE(missing_relations, ''),
      COALESCE(unexpected_relations, ''),
      COALESCE(uncovered_relations, '');
  END IF;

  IF (SELECT count(*) FROM v3_legacy_physical_relations) < 192
     OR (SELECT count(*) FROM v3_legacy_physical_relations) > 193
     OR (SELECT count(*) FROM v3_legacy_drop_roots)
       <> (SELECT count(*) FROM v3_legacy_physical_relations) - 134 THEN
    RAISE EXCEPTION '0092 internal physical/root manifest count mismatch';
  END IF;

  SELECT array_agg(relation_row.relname::text ORDER BY relation_row.relname)
  INTO actual_sequences
  FROM pg_class relation_row
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND relation_row.relkind = 'S';

  IF actual_sequences IS DISTINCT FROM (
    SELECT array_agg(expected.relation_name::text ORDER BY expected.relation_name)
    FROM v3_legacy_sequences expected
  ) THEN
    RAISE EXCEPTION '0092 sequence scope mismatch';
  END IF;

  SELECT array_agg(type_row.typname::text ORDER BY type_row.typname)
  INTO actual_enum_types
  FROM pg_type type_row
  WHERE type_row.typnamespace = 'public'::regnamespace
    AND type_row.typtype = 'e';

  IF actual_enum_types IS DISTINCT FROM (
    SELECT array_agg(expected.type_name::text ORDER BY expected.type_name)
    FROM v3_legacy_enum_types expected
  ) THEN
    RAISE EXCEPTION '0092 enum scope mismatch';
  END IF;

  IF (SELECT array_agg(function_row.oid::regprocedure::text)
      FROM pg_proc function_row
      WHERE function_row.pronamespace = 'public'::regnamespace)
     IS DISTINCT FROM ARRAY['reject_sealed_fpl_history_mutation()']::text[] THEN
    RAISE EXCEPTION '0092 public function scope mismatch';
  END IF;

  IF (SELECT count(*) FROM reporting.player_value_changes) <> (
    SELECT count(*) FROM public.player_values_history WHERE season <> '2627'
  ) + (SELECT count(*) FROM public.player_values) THEN
    RAISE EXCEPTION '0092 player value reconstruction no longer reconciles';
  END IF;
END
$legacy_physical_scope$;

DO $drop_legacy_tables$
DECLARE
  drop_list text;
BEGIN
  SELECT string_agg(format('public.%I', relation_name), ', ' ORDER BY relation_name)
  INTO drop_list
  FROM v3_legacy_drop_roots;

  EXECUTE 'DROP TABLE ' || drop_list;
END
$drop_legacy_tables$;

DO $drop_remaining_legacy_sequences$
DECLARE
  drop_list text;
BEGIN
  SELECT string_agg(format('public.%I', relation_row.relname), ', ' ORDER BY relation_row.relname)
  INTO drop_list
  FROM pg_class relation_row
  JOIN v3_legacy_sequences expected ON expected.relation_name = relation_row.relname
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND relation_row.relkind = 'S';

  IF drop_list IS NOT NULL THEN
    EXECUTE 'DROP SEQUENCE ' || drop_list;
  END IF;
END
$drop_remaining_legacy_sequences$;

DROP FUNCTION public.reject_sealed_fpl_history_mutation();

DROP TYPE
  public.chip,
  public.cup_result,
  public.fpl_season_archive_status,
  public.group_mode,
  public.knockout_mode,
  public.league_type,
  public.provider_entity_type,
  public.provider_link_status,
  public.tournament_mode,
  public.tournament_roster_mode,
  public.tournament_setup_phase,
  public.tournament_setup_status,
  public.tournament_state,
  public.understat_lane,
  public.understat_season_state,
  public.understat_sync_item_status,
  public.understat_sync_mode,
  public.understat_sync_run_status,
  public.understat_sync_trigger,
  public.value_change_type;

DO $legacy_physical_postcondition$
BEGIN
  IF (SELECT array_agg(relation_row.relname::text ORDER BY relation_row.relname)
      FROM pg_class relation_row
      WHERE relation_row.relnamespace = 'public'::regnamespace
        AND relation_row.relkind IN ('r', 'p'))
     IS DISTINCT FROM ARRAY['graphql_schema_migrations', 'sql_migrations_v2']::text[] THEN
    RAISE EXCEPTION '0092 left unexpected public physical relations';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class relation_row
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND relation_row.relkind = 'S'
  ) OR EXISTS (
    SELECT 1 FROM pg_type type_row
    WHERE type_row.typnamespace = 'public'::regnamespace
      AND type_row.typtype = 'e'
  ) OR EXISTS (
    SELECT 1 FROM pg_proc function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
  ) OR to_regprocedure('ops.reject_v2_mutation()') IS NULL THEN
    RAISE EXCEPTION '0092 sequence/enum/public-function cleanup or ledger fence is invalid';
  END IF;
END
$legacy_physical_postcondition$;

DO $release_v2_frozen_owner$
BEGIN
  EXECUTE format('REVOKE letletme_v2_frozen_owner FROM %I', session_user);
END
$release_v2_frozen_owner$;

SET LOCAL ROLE letletme_data_owner;

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
  evidence.check_name,
  evidence.source_object,
  'approved drop manifest',
  encode(sha256(convert_to(evidence.check_name || '_v1', 'UTF8')), 'hex'),
  evidence.source_count,
  0,
  NULL,
  NULL,
  0,
  '[]'::jsonb,
  'passed'
FROM ops.migration_runs run
CROSS JOIN (VALUES
  (
    '0092_drop_v2_physical_relations',
    'public v2 physical relations',
    (SELECT count(*) FROM v3_legacy_physical_relations) - 2
  ),
  ('0092_drop_v2_sequences', 'public v2 sequences', 22::bigint),
  ('0092_drop_v2_enum_types', 'public v2 enum types', 20::bigint),
  ('0092_drop_v2_public_fence_function', 'public v2 fence function', 1::bigint)
) evidence(check_name, source_object, source_count)
WHERE current_setting('letletme.v3_legacy_drop_approval', true)
  = 'APPROVE_V3_LEGACY_DROP ' || run.run_id
ON CONFLICT (run_id, check_name, source_object, target_object) DO UPDATE SET
  target_row_count = EXCLUDED.target_row_count,
  failed_count = EXCLUDED.failed_count,
  status = EXCLUDED.status,
  executed_at = now();

UPDATE ops.migration_runs run
SET
  metadata = run.metadata || jsonb_build_object(
    'legacyDropPhase', 'physical_objects_removed',
    'legacyDroppedPhysicalRelations',
      (SELECT count(*) FROM v3_legacy_physical_relations) - 2,
    'legacyDroppedSequences', 22,
    'legacyDroppedEnumTypes', 20
  ),
  updated_at = now()
WHERE current_setting('letletme.v3_legacy_drop_approval', true)
  = 'APPROVE_V3_LEGACY_DROP ' || run.run_id;

RESET ROLE;
