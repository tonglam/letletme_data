\set ON_ERROR_STOP on

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '10s';

DO $postcleanup_contract$
DECLARE
  cleanup_checks text[];
  cleanup_files text[];
  login_inherits_frozen_owner boolean;
BEGIN
  IF (SELECT count(*) FROM ops.migration_runs
      WHERE run_id = 'v3-20260808T160008Z-b9eddc0'
        AND status = 'activated'
        AND metadata ->> 'legacyDropPhase' = 'complete'
        AND metadata ? 'legacyDropCompletedAt') <> 1 THEN
    RAISE EXCEPTION 'post-cleanup run is not activated and complete';
  END IF;

  SELECT array_agg(filename ORDER BY filename)
  INTO cleanup_files
  FROM ops.schema_migrations
  WHERE filename ~ '^009[123]_';

  IF cleanup_files IS DISTINCT FROM ARRAY[
    '0091_drop_v2_reporting_and_rpcs.sql',
    '0092_drop_v2_tables_partitions_triggers.sql',
    '0093_finalize_v3_migration_ownership.sql'
  ]::text[] THEN
    RAISE EXCEPTION 'post-cleanup migration ledger is incomplete: %', cleanup_files;
  END IF;

  SELECT array_agg(check_name ORDER BY check_name)
  INTO cleanup_checks
  FROM ops.migration_objects
  WHERE run_id = 'v3-20260808T160008Z-b9eddc0'
    AND check_name ~ '^009[123]_'
    AND status = 'passed'
    AND failed_count = 0;

  IF cleanup_checks IS DISTINCT FROM ARRAY[
    '0091_drop_v2_reporting_and_rpcs',
    '0092_drop_v2_enum_types',
    '0092_drop_v2_physical_relations',
    '0092_drop_v2_public_fence_function',
    '0092_drop_v2_sequences',
    '0093_remove_graphql_ddl_ledger',
    '0093_remove_v2_ledger_compatibility',
    '0093_remove_v2_mutation_fence'
  ]::text[] THEN
    RAISE EXCEPTION 'post-cleanup evidence is incomplete: %', cleanup_checks;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ops.migration_objects
    WHERE run_id = 'v3-20260808T160008Z-b9eddc0'
      AND (status <> 'passed' OR failed_count <> 0)
  ) THEN
    RAISE EXCEPTION 'post-cleanup run contains failed reconciliation evidence';
  END IF;

  IF (SELECT count(*) FROM ops.migration_objects
      WHERE run_id = 'v3-20260808T160008Z-b9eddc0'
        AND check_name LIKE 'legacy_graphql_migration:%'
        AND source_object = 'public.graphql_schema_migrations'
        AND target_object = 'ops.migration_objects'
        AND status = 'passed'
        AND failed_count = 0) = 0 THEN
    RAISE EXCEPTION 'preserved GraphQL migration evidence is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class relation_row
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')
  ) OR EXISTS (
    SELECT 1
    FROM pg_proc function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
  ) OR EXISTS (
    SELECT 1
    FROM pg_type type_row
    WHERE type_row.typnamespace = 'public'::regnamespace
      AND type_row.typtype = 'e'
  ) OR EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    JOIN pg_class relation_row ON relation_row.oid = trigger_row.tgrelid
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND NOT trigger_row.tgisinternal
  ) OR to_regprocedure('ops.reject_v2_mutation()') IS NOT NULL THEN
    RAISE EXCEPTION 'post-cleanup public or mutation-fence residue remains';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles member_role ON member_role.oid = membership.member
    JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    WHERE granted_role.rolname = 'letletme_v2_frozen_owner'
      AND member_role.rolcanlogin
  )
  INTO login_inherits_frozen_owner;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles role_row
    WHERE role_row.rolname = 'letletme_v2_frozen_owner'
      AND NOT role_row.rolsuper
      AND NOT role_row.rolcreatedb
      AND NOT role_row.rolcreaterole
      AND NOT role_row.rolcanlogin
      AND NOT role_row.rolinherit
      AND NOT role_row.rolreplication
      AND NOT role_row.rolbypassrls
  ) OR login_inherits_frozen_owner
     OR EXISTS (SELECT 1 FROM pg_class WHERE relowner = 'letletme_v2_frozen_owner'::regrole)
     OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner = 'letletme_v2_frozen_owner'::regrole)
     OR EXISTS (SELECT 1 FROM pg_type WHERE typowner = 'letletme_v2_frozen_owner'::regrole)
     OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = 'letletme_v2_frozen_owner'::regrole)
     OR has_schema_privilege('letletme_v2_frozen_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'post-cleanup frozen-owner quarantine boundary is unsafe';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_roles role_row
    WHERE role_row.rolname IN (
      'letletme_data_owner',
      'letletme_data_writer',
      'letletme_graphql_reader'
    )
      AND (
        role_row.rolsuper
        OR role_row.rolcreatedb
        OR role_row.rolcreaterole
        OR role_row.rolcanlogin
        OR role_row.rolreplication
        OR role_row.rolbypassrls
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_roles role_row
    WHERE role_row.rolname IN (
      'letletme_data_writer',
      'letletme_graphql_reader',
      'letletme_data_runtime',
      'letletme_graphql_runtime',
      'service_role',
      'authenticated',
      'anon'
    )
      AND has_schema_privilege(role_row.rolname, 'public', 'CREATE')
  ) THEN
    RAISE EXCEPTION 'post-cleanup runtime role or public schema privilege boundary is unsafe';
  END IF;

  IF (SELECT count(*) FROM ops.dataset_publications publication
      JOIN fpl.seasons season
        ON season.season_id = publication.season_id
       AND season.is_current
      WHERE publication.dataset = 'fpl:core'
        AND publication.event_id IS NULL
        AND publication.status = 'active'
        AND publication.manifest ->> 'schemaVersion' = 'v3'
        AND publication.manifest ->> 'state' = 'active') <> 1
     OR EXISTS (
       SELECT 1
       FROM ops.dataset_publications
       WHERE status = 'staging'
     ) OR EXISTS (
       SELECT 1
       FROM ops.dataset_publications
       WHERE status = 'active'
       GROUP BY season_id, dataset, coalesce(event_id, -1)
       HAVING count(*) > 1
     ) THEN
    RAISE EXCEPTION 'post-cleanup publication boundary is invalid';
  END IF;
END
$postcleanup_contract$;

SELECT jsonb_build_object(
  'status', 'v3_postcleanup_validation_passed',
  'runId', 'v3-20260808T160008Z-b9eddc0',
  'runStatus', (SELECT status FROM ops.migration_runs
    WHERE run_id = 'v3-20260808T160008Z-b9eddc0'),
  'legacyDropPhase', (SELECT metadata ->> 'legacyDropPhase' FROM ops.migration_runs
    WHERE run_id = 'v3-20260808T160008Z-b9eddc0'),
  'migrationChecks', (SELECT count(*) FROM ops.migration_objects
    WHERE run_id = 'v3-20260808T160008Z-b9eddc0'
      AND status = 'passed' AND failed_count = 0),
  'cleanupMigrationsApplied', (SELECT count(*) FROM ops.schema_migrations
    WHERE filename ~ '^009[123]_'),
  'publicRelations', (SELECT count(*) FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'm', 'v')),
  'publicSequences', (SELECT count(*) FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relkind = 'S'),
  'publicFunctions', (SELECT count(*) FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace),
  'publicEnums', (SELECT count(*) FROM pg_type
    WHERE typnamespace = 'public'::regnamespace AND typtype = 'e'),
  'activePublications', (SELECT count(*) FROM ops.dataset_publications
    WHERE status = 'active'),
  'stagingPublications', (SELECT count(*) FROM ops.dataset_publications
    WHERE status = 'staging')
);

COMMIT;
