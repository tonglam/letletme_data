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
    AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  GROUP BY n.nspname, c.relkind
) AS row_data;

WITH public_objects AS (
  SELECT
    c.oid,
    c.relname AS object_name,
    c.relkind,
    pg_total_relation_size(c.oid)::bigint AS total_bytes,
    CASE
      WHEN c.relkind = 'S' AND c.relname = 'core_snapshot_revision_seq'
        THEN 'ops'
      WHEN c.relkind = 'S' AND c.relname ~ '^(entry_|league_|tournament_).+_id_seq$'
        THEN 'competition'
      WHEN c.relkind = 'S' AND c.relname ~ '^(event_|fpl_|player_).+_id_seq$'
        THEN 'fpl'
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
    AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
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

WITH public_types AS (
  SELECT
    t.typname AS type_name,
    t.typtype,
    coalesce((
      SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)
      FROM pg_enum e
      WHERE e.enumtypid = t.oid
    ), '[]'::jsonb) AS enum_values,
    CASE
      WHEN t.typname = 'value_change_type' THEN 'fpl'
      WHEN t.typname = ANY (ARRAY[
        'chip', 'cup_result', 'group_mode', 'knockout_mode', 'league_type',
        'tournament_mode', 'tournament_roster_mode', 'tournament_setup_phase',
        'tournament_setup_status', 'tournament_state'
      ]) THEN 'competition'
      WHEN t.typname = 'fpl_season_archive_status' THEN 'ops'
      WHEN t.typname = ANY (ARRAY['provider_entity_type', 'provider_link_status']) THEN 'bridge'
      WHEN t.typname ~ '^understat_' THEN 'understat'
      ELSE NULL
    END AS classification
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public'
    AND t.typtype IN ('e', 'd')
)
SELECT jsonb_build_object(
  'types', coalesce(jsonb_agg(jsonb_build_object(
    'name', type_name,
    'kind', typtype,
    'classification', classification,
    'enum_values', enum_values
  ) ORDER BY type_name), '[]'::jsonb),
  'classification_counts', (
    SELECT coalesce(jsonb_object_agg(classification, object_count), '{}'::jsonb)
    FROM (
      SELECT coalesce(classification, 'unclassified') AS classification,
        count(*)::integer AS object_count
      FROM public_types
      GROUP BY classification
    ) AS counts
  ),
  'unclassified', (
    SELECT coalesce(jsonb_agg(type_name ORDER BY type_name), '[]'::jsonb)
    FROM public_types
    WHERE classification IS NULL
  )
) AS public_type_inventory
FROM public_types;

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
  'effective_non_owner_acl', (
    SELECT coalesce(jsonb_agg(acl_data ORDER BY object_type, object_name, grantee, privilege_type), '[]'::jsonb)
    FROM (
      SELECT
        'schema'::text AS object_type,
        namespace.nspname::text AS object_name,
        coalesce(grantee.rolname, 'PUBLIC')::text AS grantee,
        acl.privilege_type::text,
        acl.is_grantable
      FROM pg_namespace AS namespace
      CROSS JOIN LATERAL aclexplode(
        coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))
      ) AS acl
      LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
      WHERE namespace.nspname = 'public'
        AND acl.grantee <> namespace.nspowner

      UNION ALL

      SELECT
        CASE WHEN class.relkind = 'S' THEN 'sequence' ELSE 'relation' END,
        namespace.nspname || '.' || class.relname,
        coalesce(grantee.rolname, 'PUBLIC'),
        acl.privilege_type,
        acl.is_grantable
      FROM pg_class AS class
      JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
      CROSS JOIN LATERAL aclexplode(
        coalesce(
          class.relacl,
          acldefault(
            CASE WHEN class.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
            class.relowner
          )
        )
      ) AS acl
      LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
      WHERE namespace.nspname = 'public'
        AND class.relkind IN ('r', 'p', 'v', 'm', 'S')
        AND acl.grantee <> class.relowner

      UNION ALL

      SELECT
        'function',
        namespace.nspname || '.' || procedure.proname || '(' || pg_get_function_identity_arguments(procedure.oid) || ')',
        coalesce(grantee.rolname, 'PUBLIC'),
        acl.privilege_type,
        acl.is_grantable
      FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      CROSS JOIN LATERAL aclexplode(
        coalesce(procedure.proacl, acldefault('f', procedure.proowner))
      ) AS acl
      LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
      WHERE namespace.nspname = 'public'
        AND acl.grantee <> procedure.proowner

      UNION ALL

      SELECT
        'default-' || default_acl.defaclobjtype::text,
        role.rolname || '@' || namespace.nspname,
        coalesce(grantee.rolname, 'PUBLIC'),
        acl.privilege_type,
        acl.is_grantable
      FROM pg_default_acl AS default_acl
      JOIN pg_roles AS role ON role.oid = default_acl.defaclrole
      JOIN pg_namespace AS namespace ON namespace.oid = default_acl.defaclnamespace
      CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) AS acl
      LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
      WHERE namespace.nspname = 'public'
        AND acl.grantee <> default_acl.defaclrole
    ) AS acl_data
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
