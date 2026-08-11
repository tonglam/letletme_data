-- Remove the final one-time cutover evidence after proving its exact production shape.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_advisory_xact_lock(912883473);

DO $cutover_evidence_contract$
DECLARE
  expected_check_names text[] := ARRAY[
    '0085_fpl_events_keyset',
    '0085_fpl_fixtures_keyset',
    '0085_fpl_phases_keyset',
    '0085_fpl_player_event_snapshots_keyset',
    '0085_fpl_player_fixture_stats_keyset',
    '0085_fpl_player_gameweek_scoring_items_keyset',
    '0085_fpl_player_gameweek_stats_keyset',
    '0085_fpl_player_market_snapshots_keyset',
    '0085_fpl_players_keyset',
    '0085_fpl_teams_keyset',
    '0085_reporting_player_season_summaries_rows',
    '0085_reporting_player_value_changes_rows',
    '0086_competition_entries_keyset',
    '0086_competition_entry_event_cup_results_keyset',
    '0086_competition_entry_event_picks_keyset',
    '0086_competition_entry_event_results_keyset',
    '0086_competition_entry_event_transfers_keyset',
    '0086_competition_entry_leagues_keyset',
    '0086_competition_entry_season_histories_keyset',
    '0086_competition_league_event_results_keyset',
    '0086_competition_tournament_battle_results_keyset',
    '0086_competition_tournament_entries_keyset',
    '0086_competition_tournament_groups_keyset',
    '0086_competition_tournament_knockout_results_keyset',
    '0086_competition_tournament_knockouts_keyset',
    '0086_competition_tournament_points_results_keyset',
    '0086_competition_tournaments_keyset',
    '0087_bridge_entity_aliases_rows',
    '0087_bridge_entity_links_rows',
    '0087_bridge_match_links_rows',
    '0087_ops_dataset_publications_keyset',
    '0087_ops_schema_migrations_rows',
    '0087_ops_season_imports_keyset',
    '0087_ops_understat_sync_items_source_hash',
    '0087_ops_understat_sync_runs_keyset',
    '0087_understat_matches_source_hash',
    '0087_understat_player_match_stats_source_hash',
    '0087_understat_player_seasons_source_hash',
    '0087_understat_players_source_hash',
    '0087_understat_player_team_seasons_source_hash',
    '0087_understat_seasons_rows',
    '0087_understat_team_match_stats_source_hash',
    '0087_understat_team_seasons_source_hash',
    '0087_understat_teams_source_hash',
    '0087_understat_team_stat_splits_source_hash',
    '0088_v3_constraint_and_security_contract',
    '0089_prepare_v3_publication',
    '0090_activate_v3_and_freeze_v2',
    '0091_drop_v2_reporting_and_rpcs',
    '0092_drop_v2_enum_types',
    '0092_drop_v2_physical_relations',
    '0092_drop_v2_public_fence_function',
    '0092_drop_v2_sequences',
    '0093_remove_graphql_ddl_ledger',
    '0093_remove_v2_ledger_compatibility',
    '0093_remove_v2_mutation_fence',
    'legacy_graphql_migration:202607180001_tournament_selection_stats_security.sql',
    'legacy_graphql_migration:202607210002_required_read_rpcs.sql',
    'legacy_graphql_migration:202608030001_market_player_search.sql',
    'legacy_graphql_migration:202608080001_player_picker_search_filters.sql',
    'legacy_graphql_migration:202608080002_public_league_trends_catalog.sql'
  ]::text[];
  expected_metadata_keys text[] := ARRAY[
    'activatedPlanVersion',
    'legacyDropApproval',
    'legacyDropCompletedAt',
    'legacyDroppedEnumTypes',
    'legacyDroppedPhysicalRelations',
    'legacyDroppedSequences',
    'legacyDropPhase',
    'legacyDropStartedAt',
    'purpose',
    'sourceProfile',
    'v2FreezeState',
    'v2PhysicalRelationCount',
    'v2ReadRelationCount',
    'v2SequenceCount'
  ]::text[];
  actual_check_names text[];
  actual_metadata_keys text[];
  run_metadata jsonb;
BEGIN
  IF to_regclass('ops.migration_runs') IS NULL
     OR to_regclass('ops.migration_objects') IS NULL THEN
    RAISE EXCEPTION '0094 requires both cutover evidence tables';
  END IF;

  IF (SELECT count(*) FROM ops.migration_runs) <> 1 THEN
    RAISE EXCEPTION '0094 expected exactly one cutover run';
  END IF;

  SELECT metadata INTO run_metadata
  FROM ops.migration_runs
  WHERE run_id = 'v3-20260808T160008Z-b9eddc0'
    AND plan_version = '3.1.1'
    AND source_project = 'gtwcfjoviibmtkevurjw'
    AND source_postgres_version = '15.8'
    AND source_data_sha = 'b9eddc0'
    AND status = 'activated'
    AND completed_at IS NOT NULL
    AND completed_at >= started_at;

  IF run_metadata IS NULL THEN
    RAISE EXCEPTION '0094 cutover run identity or terminal status is unexpected';
  END IF;

  SELECT array_agg(key ORDER BY key) INTO actual_metadata_keys
  FROM jsonb_object_keys(run_metadata) key;
  IF actual_metadata_keys IS DISTINCT FROM expected_metadata_keys THEN
    RAISE EXCEPTION '0094 cutover metadata keys differ: %', actual_metadata_keys;
  END IF;

  IF run_metadata ->> 'purpose' <> 'production B0 upgrade replay'
     OR run_metadata ->> 'sourceProfile' NOT IN ('b0_nonempty', 'fresh_empty')
     OR run_metadata ->> 'v2FreezeState' <> 'trigger_and_acl_fenced'
     OR run_metadata ->> 'legacyDropPhase' <> 'complete'
     OR run_metadata ->> 'activatedPlanVersion' <> '3.1.1'
     OR run_metadata ->> 'legacyDropApproval'
        <> 'APPROVE_V3_LEGACY_DROP v3-20260808T160008Z-b9eddc0'
     OR jsonb_typeof(run_metadata -> 'legacyDropStartedAt') <> 'string'
     OR jsonb_typeof(run_metadata -> 'legacyDropCompletedAt') <> 'string'
     OR (run_metadata ->> 'legacyDropStartedAt')::timestamptz
        > (run_metadata ->> 'legacyDropCompletedAt')::timestamptz THEN
    RAISE EXCEPTION '0094 cutover metadata values are unexpected';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'v2SequenceCount',
      'v2ReadRelationCount',
      'legacyDroppedEnumTypes',
      'legacyDroppedSequences',
      'v2PhysicalRelationCount',
      'legacyDroppedPhysicalRelations'
    ]::text[]) numeric_key
    WHERE jsonb_typeof(run_metadata -> numeric_key) <> 'number'
       OR (run_metadata ->> numeric_key)::bigint < 0
  ) THEN
    RAISE EXCEPTION '0094 cutover metadata counts are invalid';
  END IF;

  SELECT array_agg(DISTINCT check_name ORDER BY check_name)
  INTO actual_check_names
  FROM ops.migration_objects;
  IF actual_check_names IS DISTINCT FROM expected_check_names
     OR (SELECT count(*) FROM ops.migration_objects) <> cardinality(expected_check_names)
     OR EXISTS (
       SELECT 1 FROM ops.migration_objects
       WHERE run_id <> 'v3-20260808T160008Z-b9eddc0'
          OR status <> 'passed'
          OR failed_count <> 0
          OR sample_failed_keys <> '[]'::jsonb
          OR query_sha256 !~ '^[0-9a-f]{64}$'
          OR btrim(source_object) = ''
          OR btrim(target_object) = ''
     ) THEN
    RAISE EXCEPTION '0094 cutover object evidence differs from the approved set';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    WHERE (
      constraint_row.conrelid IN ('ops.migration_runs'::regclass, 'ops.migration_objects'::regclass)
      OR constraint_row.confrelid IN (
        'ops.migration_runs'::regclass,
        'ops.migration_objects'::regclass
      )
    )
      AND constraint_row.conname NOT IN (
        'migration_runs_pkey',
        'migration_runs_run_id_format',
        'migration_runs_plan_version_nonempty',
        'migration_runs_source_sha_format',
        'migration_runs_status_valid',
        'migration_runs_completion_order',
        'migration_runs_metadata_object',
        'migration_objects_pkey',
        'migration_objects_run_fk',
        'migration_objects_check_name_nonempty',
        'migration_objects_query_hash_sha256',
        'migration_objects_counts_nonnegative',
        'migration_objects_samples_array',
        'migration_objects_status_valid'
      )
  ) THEN
    RAISE EXCEPTION '0094 found an unexpected constraint dependency';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_depend dependency
    JOIN pg_rewrite rewrite_row ON rewrite_row.oid = dependency.objid
    JOIN pg_class dependent_relation ON dependent_relation.oid = rewrite_row.ev_class
    WHERE dependency.refobjid IN (
      'ops.migration_runs'::regclass,
      'ops.migration_objects'::regclass
    )
      AND dependent_relation.oid NOT IN (
        'ops.migration_runs'::regclass,
        'ops.migration_objects'::regclass
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    WHERE trigger_row.tgrelid IN (
      'ops.migration_runs'::regclass,
      'ops.migration_objects'::regclass
    )
      AND NOT trigger_row.tgisinternal
  ) OR EXISTS (
    SELECT 1
    FROM pg_proc function_row
    JOIN pg_namespace namespace_row ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname !~ '^pg_'
      AND function_row.prokind IN ('f', 'p')
      AND pg_get_functiondef(function_row.oid)
        ~ 'ops[.]migration_(runs|objects)'
  ) THEN
    RAISE EXCEPTION '0094 found a runtime dependency on cutover evidence';
  END IF;
END
$cutover_evidence_contract$;

DO $retired_role_contract$
DECLARE
  retired_role_oid oid;
BEGIN
  SELECT role_row.oid INTO retired_role_oid
  FROM pg_roles role_row
  WHERE role_row.rolname = 'letletme_v2_frozen_owner'
    AND NOT role_row.rolsuper
    AND NOT role_row.rolcreatedb
    AND NOT role_row.rolcreaterole
    AND NOT role_row.rolcanlogin
    AND NOT role_row.rolinherit
    AND NOT role_row.rolreplication
    AND NOT role_row.rolbypassrls
    AND role_row.rolconfig IS NULL;

  IF retired_role_oid IS NULL THEN
    RAISE EXCEPTION '0094 retired v2 owner is missing or unsafe';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_auth_members membership
    WHERE membership.member = retired_role_oid OR membership.roleid = retired_role_oid
  ) OR EXISTS (
    SELECT 1 FROM pg_shdepend dependency
    WHERE dependency.refclassid = 'pg_authid'::regclass
      AND dependency.refobjid = retired_role_oid
  ) THEN
    RAISE EXCEPTION '0094 retired v2 owner still has membership, ownership, or grants';
  END IF;
END
$retired_role_contract$;

SET LOCAL ROLE letletme_data_owner;
DROP TABLE ops.migration_objects, ops.migration_runs RESTRICT;
RESET ROLE;

DROP ROLE letletme_v2_frozen_owner;

DO $postcondition$
DECLARE
  ops_tables text[];
BEGIN
  IF to_regclass('ops.migration_runs') IS NOT NULL
     OR to_regclass('ops.migration_objects') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'letletme_v2_frozen_owner') THEN
    RAISE EXCEPTION '0094 did not remove all cutover-only objects';
  END IF;

  SELECT array_agg(relation_row.relname::text ORDER BY relation_row.relname)
  INTO ops_tables
  FROM pg_class relation_row
  WHERE relation_row.relnamespace = 'ops'::regnamespace
    AND relation_row.relkind IN ('r', 'p');

  IF ops_tables IS DISTINCT FROM ARRAY[
    'dataset_publications',
    'schema_migrations',
    'season_imports',
    'sync_items',
    'sync_runs'
  ]::text[] THEN
    RAISE EXCEPTION '0094 final ops table set differs: %', ops_tables;
  END IF;
END
$postcondition$;
