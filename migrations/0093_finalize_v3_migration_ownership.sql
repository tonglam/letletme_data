-- Approval-gated final removal of the temporary public migration ledgers.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

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
    AND run.metadata ->> 'legacyDropPhase' = 'physical_objects_removed';

  IF approved_run_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = '0093 requires exact approval and a completed 0092 phase';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM ops.migration_objects
    WHERE check_name = '0092_drop_v2_physical_relations'
      AND status = 'passed'
  ) THEN
    RAISE EXCEPTION '0093 cannot find passing 0092 evidence';
  END IF;
END
$legacy_drop_approval$;

DO $assume_v2_frozen_owner$
BEGIN
  EXECUTE format('GRANT letletme_v2_frozen_owner TO %I', session_user);
END
$assume_v2_frozen_owner$;

DO $legacy_ledger_scope$
DECLARE
  actual_physical text[];
  actual_views text[];
  graphql_difference_count bigint;
  ledger_difference_count bigint;
BEGIN
  SELECT array_agg(relation_row.relname::text ORDER BY relation_row.relname)
  INTO actual_physical
  FROM pg_class relation_row
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND relation_row.relkind IN ('r', 'p');

  IF actual_physical IS DISTINCT FROM ARRAY[
    'graphql_schema_migrations',
    'sql_migrations_v2'
  ]::text[] THEN
    RAISE EXCEPTION '0093 physical ledger scope mismatch: %', actual_physical;
  END IF;

  SELECT array_agg(relation_row.relname::text ORDER BY relation_row.relname)
  INTO actual_views
  FROM pg_class relation_row
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND relation_row.relkind = 'v';

  IF actual_views IS DISTINCT FROM ARRAY['sql_migrations']::text[] THEN
    RAISE EXCEPTION '0093 compatibility-view scope mismatch: %', actual_views;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class relation_row
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND relation_row.relkind IN ('m', 'S')
  ) OR EXISTS (
    SELECT 1 FROM pg_type type_row
    WHERE type_row.typnamespace = 'public'::regnamespace
      AND type_row.typtype = 'e'
  ) OR EXISTS (
    SELECT 1 FROM pg_proc function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
  ) THEN
    RAISE EXCEPTION '0093 found an unexpected public MV, sequence, enum, or function';
  END IF;

  IF (SELECT count(*) FROM pg_trigger trigger_row
      JOIN pg_class relation_row ON relation_row.oid = trigger_row.tgrelid
      WHERE relation_row.relnamespace = 'public'::regnamespace
        AND trigger_row.tgname = 'v3_reject_v2_mutation'
        AND NOT trigger_row.tgisinternal) <> 2 THEN
    RAISE EXCEPTION '0093 expected two final ledger mutation fences';
  END IF;

  SELECT count(*) INTO ledger_difference_count
  FROM public.sql_migrations_v2 legacy
  LEFT JOIN ops.schema_migrations target USING (filename)
  WHERE target.filename IS NULL
     OR legacy.checksum IS DISTINCT FROM target.checksum
     OR legacy.applied_at IS DISTINCT FROM target.applied_at;

  IF ledger_difference_count <> 0 THEN
    RAISE EXCEPTION '0093 Data ledger preservation mismatch: %', ledger_difference_count;
  END IF;

  SELECT count(*) INTO graphql_difference_count
  FROM public.graphql_schema_migrations legacy
  LEFT JOIN ops.migration_objects target
    ON target.check_name = 'legacy_graphql_migration:' || legacy.version
   AND target.source_object = 'public.graphql_schema_migrations'
   AND target.target_object = 'ops.migration_objects'
   AND target.source_hash = legacy.checksum
   AND target.target_hash = legacy.checksum
   AND target.status = 'passed'
  WHERE target.check_name IS NULL;

  IF (SELECT count(*) FROM public.graphql_schema_migrations) <> 3
     OR graphql_difference_count <> 0 THEN
    RAISE EXCEPTION '0093 GraphQL ledger preservation mismatch: rows=%, differences=%',
      (SELECT count(*) FROM public.graphql_schema_migrations),
      graphql_difference_count;
  END IF;
END
$legacy_ledger_scope$;

DROP VIEW public.sql_migrations;
DROP TABLE public.sql_migrations_v2, public.graphql_schema_migrations;
DROP FUNCTION ops.reject_v2_mutation();

DO $release_v2_frozen_owner$
BEGIN
  EXECUTE format('REVOKE letletme_v2_frozen_owner FROM %I', session_user);
END
$release_v2_frozen_owner$;

DO $legacy_ledger_postcondition$
DECLARE
  migration_login_inherits_frozen_owner boolean;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class relation_row
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')
  ) OR EXISTS (
    SELECT 1 FROM pg_type type_row
    WHERE type_row.typnamespace = 'public'::regnamespace
      AND type_row.typtype = 'e'
  ) OR EXISTS (
    SELECT 1 FROM pg_proc function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
  ) OR to_regprocedure('ops.reject_v2_mutation()') IS NOT NULL THEN
    RAISE EXCEPTION '0093 left a Data-owned legacy public object';
  END IF;

  -- Roles are cluster-wide while this migration owns one database. Keep the
  -- locked NOLOGIN role as an empty quarantine role instead of attempting a
  -- cross-database DROP ROLE, but prove it owns nothing in this database and
  -- the migration login cannot inherit it.
  -- pg_has_role() reports superusers as members of every role without a
  -- pg_auth_members edge, so use the same real-grant/non-superuser contract as
  -- the activation migration.
  SELECT
    EXISTS (
      SELECT 1
      FROM pg_auth_members membership
      JOIN pg_roles member_role ON member_role.oid = membership.member
      JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
      WHERE member_role.rolname = session_user
        AND granted_role.rolname = 'letletme_v2_frozen_owner'
    ) OR (
      NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user)
      AND pg_has_role(session_user, 'letletme_v2_frozen_owner', 'MEMBER')
    )
  INTO migration_login_inherits_frozen_owner;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles role_row
    WHERE role_row.rolname = 'letletme_v2_frozen_owner'
      AND NOT role_row.rolsuper
      AND NOT role_row.rolcreatedb
      AND NOT role_row.rolcreaterole
      AND NOT role_row.rolcanlogin
      AND NOT role_row.rolinherit
      AND NOT role_row.rolbypassrls
  ) OR migration_login_inherits_frozen_owner
     OR EXISTS (SELECT 1 FROM pg_class WHERE relowner = 'letletme_v2_frozen_owner'::regrole)
     OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner = 'letletme_v2_frozen_owner'::regrole)
     OR EXISTS (SELECT 1 FROM pg_type WHERE typowner = 'letletme_v2_frozen_owner'::regrole)
     OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = 'letletme_v2_frozen_owner'::regrole)
  THEN
    RAISE EXCEPTION '0093 left an unsafe or non-empty v2 frozen owner boundary';
  END IF;
END
$legacy_ledger_postcondition$;

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
  evidence.target_object,
  encode(sha256(convert_to(evidence.check_name || '_v1', 'UTF8')), 'hex'),
  evidence.source_count,
  evidence.target_count,
  NULL,
  NULL,
  0,
  '[]'::jsonb,
  'passed'
FROM ops.migration_runs run
CROSS JOIN (VALUES
  (
    '0093_remove_v2_ledger_compatibility',
    'public.sql_migrations view + sql_migrations_v2 table',
    'ops.schema_migrations',
    2::bigint,
    1::bigint
  ),
  (
    '0093_remove_graphql_ddl_ledger',
    'public.graphql_schema_migrations',
    'ops.migration_objects',
    1::bigint,
    1::bigint
  ),
  (
    '0093_remove_v2_mutation_fence',
    'ops.reject_v2_mutation()',
    'no compatibility target',
    1::bigint,
    0::bigint
  )
) evidence(
  check_name,
  source_object,
  target_object,
  source_count,
  target_count
)
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
    'legacyDropPhase', 'complete',
    'legacyDropCompletedAt', now()
  ),
  updated_at = now()
WHERE current_setting('letletme.v3_legacy_drop_approval', true)
  = 'APPROVE_V3_LEGACY_DROP ' || run.run_id;

RESET ROLE;
