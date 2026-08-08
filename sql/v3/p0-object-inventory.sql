-- Data Platform v3 P0 production inventory.
-- Read-only: safe to run with psql -X -v ON_ERROR_STOP=1 -f <file>.

SELECT jsonb_build_object(
  'captured_at', clock_timestamp(),
  'server_version', current_setting('server_version'),
  'database', current_database(),
  'database_bytes', pg_database_size(current_database()),
  'database_size', pg_size_pretty(pg_database_size(current_database()))
) AS database_baseline;

SELECT jsonb_agg(row_data ORDER BY schema_name, relkind) AS schema_summary
FROM (
  SELECT
    n.nspname AS schema_name,
    c.relkind,
    count(*)::integer AS object_count,
    sum(pg_total_relation_size(c.oid))::bigint AS total_bytes
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  GROUP BY n.nspname, c.relkind
) AS row_data;

WITH public_objects AS (
  SELECT
    c.oid,
    c.relname AS object_name,
    c.relkind,
    pg_total_relation_size(c.oid)::bigint AS total_bytes,
    CASE
      WHEN c.relname ~ '^(events|teams|players|phases|event_fixtures|player_stats|event_lives|event_live_explains|fpl_player_fixture_stats|player_market_snapshots|event_live_summaries|player_values)(_history|_[0-9]{4})?$'
        THEN 'fpl'
      WHEN c.relname = ANY (ARRAY[
        'entry_infos', 'entry_history_infos', 'entry_league_infos', 'entry_event_picks',
        'entry_event_results', 'entry_event_transfers', 'entry_event_cup_results',
        'league_event_results', 'tournament_infos', 'tournament_entries', 'tournament_groups',
        'tournament_knockouts', 'tournament_battle_group_results',
        'tournament_points_group_results', 'tournament_knockout_results',
        'tournament_selection_stats'
      ]) THEN 'competition'
      WHEN c.relname ~ '^understat_' THEN 'understat'
      WHEN c.relname = ANY (ARRAY[
        'provider_entity_links', 'provider_match_links', 'provider_entity_aliases'
      ]) THEN 'bridge'
      WHEN c.relname = ANY (ARRAY[
        'core_snapshot_authority', 'fpl_season_archives', 'fpl_season_archive_items',
        'sql_migrations', 'graphql_schema_migrations'
      ]) THEN 'ops'
      WHEN c.relname = ANY (ARRAY[
        'mv_tournament_event_snapshot', 'mv_tournament_snapshot', 'v_tournament_event_result',
        'v_tournament_event_snapshot', 'v_tournament_snapshot',
        'v_tournament_selection_stats'
      ]) THEN 'reporting'
      ELSE NULL
    END AS classification
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
)
SELECT jsonb_build_object(
  'objects', (
    SELECT jsonb_agg(jsonb_build_object(
      'name', object_name,
      'kind', relkind,
      'classification', classification,
      'total_bytes', total_bytes
    ) ORDER BY relkind, object_name)
    FROM public_objects
  ),
  'classification_counts', (
    SELECT jsonb_agg(classified ORDER BY classification, relkind)
    FROM (
      SELECT classification, relkind, count(*)::integer AS object_count
      FROM public_objects
      GROUP BY classification, relkind
    ) AS classified
  ),
  'unclassified', (
    SELECT coalesce(jsonb_agg(jsonb_build_object('name', object_name, 'kind', relkind)
      ORDER BY relkind, object_name), '[]'::jsonb)
    FROM public_objects
    WHERE classification IS NULL
  )
) AS public_object_inventory;

SELECT jsonb_agg(function_data ORDER BY function_name, identity_arguments) AS public_functions
FROM (
  SELECT
    p.proname AS function_name,
    pg_get_function_identity_arguments(p.oid) AS identity_arguments,
    pg_get_function_result(p.oid) AS result_type,
    p.prosecdef AS security_definer,
    pg_get_functiondef(p.oid) AS definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
) AS function_data;

SELECT jsonb_agg(trigger_data ORDER BY table_name, trigger_name) AS public_triggers
FROM (
  SELECT
    c.oid::regclass::text AS table_name,
    t.tgname AS trigger_name,
    pg_get_triggerdef(t.oid, true) AS definition
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND NOT t.tgisinternal
) AS trigger_data;

SELECT jsonb_build_object(
  'policies', (
    SELECT coalesce(jsonb_agg(policy_data ORDER BY tablename, policyname), '[]'::jsonb)
    FROM (
      SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public'
    ) AS policy_data
  ),
  'non_owner_grants', (
    SELECT coalesce(jsonb_agg(grant_data ORDER BY table_name, grantee, privilege_type), '[]'::jsonb)
    FROM (
      SELECT
        table_schema || '.' || table_name AS table_name,
        grantee,
        privilege_type
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND grantee <> 'postgres'
    ) AS grant_data
  )
) AS public_security_inventory;

SELECT jsonb_build_object(
  'constraints', (
    SELECT jsonb_agg(constraint_data ORDER BY table_name, constraint_name)
    FROM (
      SELECT
        c.conrelid::regclass::text AS table_name,
        c.conname AS constraint_name,
        c.contype AS constraint_type,
        pg_get_constraintdef(c.oid, true) AS definition,
        c.convalidated AS validated
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public'
    ) AS constraint_data
  ),
  'indexes', (
    SELECT jsonb_agg(index_data ORDER BY table_name, index_name)
    FROM (
      SELECT
        t.oid::regclass::text AS table_name,
        i.indexrelid::regclass::text AS index_name,
        pg_get_indexdef(i.indexrelid) AS definition,
        i.indisvalid AS valid,
        i.indisunique AS unique_index
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
    ) AS index_data
  )
) AS public_integrity_inventory;

SELECT jsonb_build_object(
  'data_sql_migrations', (
    SELECT jsonb_agg(migration_data ORDER BY filename)
    FROM (
      SELECT filename, checksum, applied_at
      FROM public.sql_migrations
    ) AS migration_data
  ),
  'graphql_migrations', (
    SELECT jsonb_agg(graphql_data ORDER BY version)
    FROM (
      SELECT version, checksum, applied_at
      FROM public.graphql_schema_migrations
    ) AS graphql_data
  ),
  'supabase_migrations', (
    SELECT jsonb_agg(supabase_data ORDER BY version)
    FROM (
      SELECT version, name
      FROM supabase_migrations.schema_migrations
    ) AS supabase_data
  )
) AS migration_ledger_inventory;
