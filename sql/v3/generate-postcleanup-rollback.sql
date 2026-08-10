\set ON_ERROR_STOP on
\o /dev/null
\set QUIET 1
\pset tuples_only on
\pset format unaligned
\pset pager off
\unset QUIET

-- Usage (run both commands against the frozen, activated B1 source before cleanup):
--   psql -v cutover_run_id=v3-... -v legacy_dump_sha256=<raw custom-dump sha256> \
--     -v capsule_phase=pre -f sql/v3/generate-postcleanup-rollback.sql \
--     > postcleanup-rollback-pre.sql
--   psql -v cutover_run_id=v3-... -v legacy_dump_sha256=<raw custom-dump sha256> \
--     -v capsule_phase=post -f sql/v3/generate-postcleanup-rollback.sql \
--     > postcleanup-rollback-post.sql
--
-- Encrypt both generated capsules immediately. During recovery, run the pre capsule, restore the
-- exact B1 public custom dump with pg_restore --clean --if-exists, then run the post capsule. The
-- capsules restore only the non-public state changed by 0091-0093; all legacy business objects and
-- data come from the B1 dump rather than being reconstructed from migration source.

SELECT :'cutover_run_id'::text;
SELECT :'legacy_dump_sha256'::text;
SELECT :'capsule_phase'::text;
SELECT set_config('letletme.v3_postcleanup_capsule_run_id', :'cutover_run_id', false);
SELECT set_config('letletme.v3_postcleanup_dump_sha256', :'legacy_dump_sha256', false);
SELECT set_config('letletme.v3_postcleanup_capsule_phase', :'capsule_phase', false);

DO $generator_preflight$
DECLARE
  capsule_run_id text := current_setting('letletme.v3_postcleanup_capsule_run_id', true);
  dump_sha256 text := current_setting('letletme.v3_postcleanup_dump_sha256', true);
  capsule_phase text := current_setting('letletme.v3_postcleanup_capsule_phase', true);
BEGIN
  IF capsule_run_id !~ '^v3-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,12}$' THEN
    RAISE EXCEPTION 'invalid cutover run ID for post-cleanup rollback capsule';
  END IF;

  IF dump_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'post-cleanup rollback capsule requires the raw B1 legacy dump SHA-256';
  END IF;

  IF capsule_phase NOT IN ('pre', 'post') THEN
    RAISE EXCEPTION 'capsule_phase must be pre or post';
  END IF;

  IF current_setting('server_version_num')::integer / 10000 <> 15 THEN
    RAISE EXCEPTION 'post-cleanup rollback capsule requires PostgreSQL 15';
  END IF;

  IF (SELECT count(*) FROM ops.migration_runs
      WHERE migration_runs.run_id = capsule_run_id) <> 1
     OR (SELECT status FROM ops.migration_runs
         WHERE migration_runs.run_id = capsule_run_id)
        <> 'activated'
     OR EXISTS (
       SELECT 1
       FROM ops.migration_runs
       WHERE migration_runs.run_id = capsule_run_id
         AND metadata ? 'legacyDropPhase'
     ) THEN
    RAISE EXCEPTION 'capsule source must be the activated B1 state before legacy cleanup';
  END IF;

  IF (SELECT count(*) FROM pg_class relation_row
      WHERE relation_row.relnamespace = 'public'::regnamespace
        AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S'))
      <> 221 + CASE
        WHEN to_regclass('public.public_league_trends_catalog') IS NULL THEN 0
        ELSE 1
      END
     OR (SELECT count(*) FROM pg_proc function_row
         WHERE function_row.pronamespace = 'public'::regnamespace)
      <> 6 + CASE
        WHEN to_regclass('public.public_league_trends_catalog') IS NULL THEN 0
        ELSE 2
      END
     OR (SELECT count(*) FROM pg_type type_row
         WHERE type_row.typnamespace = 'public'::regnamespace
           AND type_row.typtype = 'e') <> 20
     OR (SELECT count(*) FROM pg_trigger trigger_row
         JOIN pg_class relation_row ON relation_row.oid = trigger_row.tgrelid
         WHERE relation_row.relnamespace = 'public'::regnamespace
           AND trigger_row.tgname = 'v3_reject_v2_mutation'
           AND NOT trigger_row.tgisinternal)
      <> 192 + CASE
        WHEN to_regclass('public.public_league_trends_catalog') IS NULL THEN 0
        ELSE 1
      END
     OR to_regprocedure('ops.reject_v2_mutation()') IS NULL THEN
    RAISE EXCEPTION 'capsule source differs from the accepted activated B1 object contract';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ops.schema_migrations
    WHERE filename ~ '^009[1-3]_'
  ) OR EXISTS (
    SELECT 1
    FROM ops.migration_objects
    WHERE check_name ~ '^009[1-3]_'
  ) THEN
    RAISE EXCEPTION 'capsule source already contains legacy-cleanup ledger state';
  END IF;
END
$generator_preflight$;

SELECT :'capsule_phase' = 'pre' AS generate_pre \gset
\o

SELECT '\set ON_ERROR_STOP on';
SELECT '\if :{?rollback_approval}';
SELECT '\else';
SELECT '\echo rollback_approval is required';
SELECT
  'DO $missing_rollback_approval$ BEGIN '
  || 'RAISE EXCEPTION ''rollback_approval is required''; '
  || 'END $missing_rollback_approval$;';
SELECT '\endif';
SELECT '\if :{?legacy_dump_sha256}';
SELECT '\else';
SELECT '\echo legacy_dump_sha256 is required';
SELECT
  'DO $missing_legacy_dump_sha256$ BEGIN '
  || 'RAISE EXCEPTION ''legacy_dump_sha256 is required''; '
  || 'END $missing_legacy_dump_sha256$;';
SELECT '\endif';
SELECT 'BEGIN;';
SELECT 'SET LOCAL lock_timeout = ''5s'';';
SELECT 'SET LOCAL statement_timeout = ''15min'';';
SELECT 'SELECT pg_advisory_xact_lock(912883475);';
SELECT
  'SELECT set_config(''letletme.v3_postcleanup_rollback_approval'', '
  || ':''rollback_approval'', true);';
SELECT
  'SELECT set_config(''letletme.v3_postcleanup_rollback_dump_sha256'', '
  || ':''legacy_dump_sha256'', true);';

SELECT format(
  $capsule$
DO $rollback_identity_gate$
DECLARE
  approval text := current_setting('letletme.v3_postcleanup_rollback_approval', true);
  supplied_dump_sha256 text :=
    current_setting('letletme.v3_postcleanup_rollback_dump_sha256', true);
BEGIN
  IF approval IS DISTINCT FROM %L THEN
    RAISE EXCEPTION 'post-cleanup rollback approval does not match this capsule';
  END IF;
  IF supplied_dump_sha256 IS DISTINCT FROM %L THEN
    RAISE EXCEPTION 'post-cleanup rollback B1 legacy dump SHA-256 does not match this capsule';
  END IF;
  IF current_setting('server_version_num')::integer / 10000 <> 15 THEN
    RAISE EXCEPTION 'post-cleanup rollback requires PostgreSQL 15';
  END IF;
END
$rollback_identity_gate$;
$capsule$,
  'APPROVE_V3_POSTCLEANUP_ROLLBACK ' || :'cutover_run_id',
  :'legacy_dump_sha256'
);

\if :generate_pre

SELECT format(
  $capsule$
DO $postcleanup_pre_restore_gate$
DECLARE
  cleanup_phase text;
  cleanup_migration_count bigint;
  cleanup_object_count bigint;
  public_physical_count bigint;
  public_view_count bigint;
  public_mv_count bigint;
  public_sequence_count bigint;
  public_function_count bigint;
  public_enum_count bigint;
BEGIN
  SELECT metadata ->> 'legacyDropPhase'
  INTO cleanup_phase
  FROM ops.migration_runs
  WHERE run_id = %L AND status = 'activated';

  IF cleanup_phase IS NULL OR cleanup_phase NOT IN (
    'reporting_and_rpcs_removed',
    'physical_objects_removed',
    'complete'
  ) THEN
    RAISE EXCEPTION 'post-cleanup rollback requires a completed 0091, 0092, or 0093 boundary';
  END IF;

  SELECT count(*) INTO cleanup_migration_count
  FROM ops.schema_migrations
  WHERE filename ~ '^009[1-3]_';

  SELECT count(*) INTO cleanup_object_count
  FROM ops.migration_objects
  WHERE run_id = %L AND check_name ~ '^009[1-3]_';

  SELECT
    count(*) FILTER (WHERE relkind IN ('r', 'p')),
    count(*) FILTER (WHERE relkind = 'v'),
    count(*) FILTER (WHERE relkind = 'm'),
    count(*) FILTER (WHERE relkind = 'S')
  INTO
    public_physical_count,
    public_view_count,
    public_mv_count,
    public_sequence_count
  FROM pg_class
  WHERE relnamespace = 'public'::regnamespace;

  SELECT count(*) INTO public_function_count
  FROM pg_proc WHERE pronamespace = 'public'::regnamespace;

  SELECT count(*) INTO public_enum_count
  FROM pg_type
  WHERE typnamespace = 'public'::regnamespace AND typtype = 'e';

  IF cleanup_phase = 'reporting_and_rpcs_removed' AND NOT (
    cleanup_migration_count = 1
    AND cleanup_object_count = 1
    AND public_physical_count = 192 + CASE
      WHEN to_regclass('public.public_league_trends_catalog') IS NULL THEN 0
      ELSE 1
    END
    AND public_view_count = 1
    AND public_mv_count = 0
    AND public_sequence_count = 22
    AND public_function_count = 1
    AND public_enum_count = 20
    AND to_regprocedure('ops.reject_v2_mutation()') IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0091 rollback boundary differs from the exact cleanup contract';
  ELSIF cleanup_phase = 'physical_objects_removed' AND NOT (
    cleanup_migration_count = 2
    AND cleanup_object_count = 5
    AND public_physical_count = 2
    AND public_view_count = 1
    AND public_mv_count = 0
    AND public_sequence_count = 0
    AND public_function_count = 0
    AND public_enum_count = 0
    AND to_regprocedure('ops.reject_v2_mutation()') IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0092 rollback boundary differs from the exact cleanup contract';
  ELSIF cleanup_phase = 'complete' AND NOT (
    cleanup_migration_count = 3
    AND cleanup_object_count = 8
    AND public_physical_count = 0
    AND public_view_count = 0
    AND public_mv_count = 0
    AND public_sequence_count = 0
    AND public_function_count = 0
    AND public_enum_count = 0
    AND to_regprocedure('ops.reject_v2_mutation()') IS NULL
  ) THEN
    RAISE EXCEPTION '0093 rollback boundary differs from the exact cleanup contract';
  END IF;
END
$postcleanup_pre_restore_gate$;
$capsule$,
  :'cutover_run_id',
  :'cutover_run_id'
);

SELECT pg_get_functiondef('ops.reject_v2_mutation()'::regprocedure) || ';'
FROM pg_proc
WHERE oid = 'ops.reject_v2_mutation()'::regprocedure;

SELECT format(
  'ALTER FUNCTION ops.reject_v2_mutation() OWNER TO %I;',
  pg_get_userbyid(function_row.proowner)
)
FROM pg_proc function_row
WHERE function_row.oid = 'ops.reject_v2_mutation()'::regprocedure;

-- CREATE FUNCTION can inherit current default EXECUTE grants. Normalize first, then replay only
-- the non-owner ACL entries captured from B1.
SELECT $capsule$
DO $normalize_fence_acl$
DECLARE
  grantee_name text;
BEGIN
  FOR grantee_name IN
    SELECT CASE acl_row.grantee
      WHEN 0 THEN 'PUBLIC'
      ELSE quote_ident(pg_get_userbyid(acl_row.grantee))
    END
    FROM pg_proc function_row
    CROSS JOIN LATERAL aclexplode(coalesce(
      function_row.proacl,
      acldefault('f', function_row.proowner)
    )) acl_row
    WHERE function_row.oid = 'ops.reject_v2_mutation()'::regprocedure
      AND acl_row.grantee <> function_row.proowner
    GROUP BY acl_row.grantee
  LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ops.reject_v2_mutation() FROM ' || grantee_name;
  END LOOP;
END
$normalize_fence_acl$;
$capsule$;

SELECT format(
  'GRANT %s ON FUNCTION ops.reject_v2_mutation() TO %s%s;',
  acl_row.privilege_type,
  CASE acl_row.grantee
    WHEN 0 THEN 'PUBLIC'
    ELSE quote_ident(pg_get_userbyid(acl_row.grantee))
  END,
  CASE WHEN acl_row.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
)
FROM pg_proc function_row
CROSS JOIN LATERAL aclexplode(coalesce(
  function_row.proacl,
  acldefault('f', function_row.proowner)
)) acl_row
WHERE function_row.oid = 'ops.reject_v2_mutation()'::regprocedure
  AND acl_row.grantee <> function_row.proowner
ORDER BY acl_row.grantee, acl_row.privilege_type, acl_row.is_grantable;

SELECT 'COMMIT;';
SELECT
  'SELECT ''postcleanup_rollback_pre_passed'' AS status, '
  || 'current_database() AS database_name;';

\else

WITH baseline AS (
  SELECT
    (SELECT count(*) FROM ops.schema_migrations)::bigint AS migration_count,
    (
      SELECT encode(sha256(convert_to(coalesce(string_agg(
        to_jsonb(migration_row)::text,
        E'\n' ORDER BY migration_row.filename
      ), ''), 'UTF8')), 'hex')
      FROM ops.schema_migrations migration_row
    ) AS migration_hash,
    (SELECT count(*) FROM ops.migration_objects)::bigint AS object_count,
    (
      SELECT encode(sha256(convert_to(coalesce(string_agg(
        to_jsonb(object_row)::text,
        E'\n' ORDER BY
          object_row.run_id,
          object_row.check_name,
          object_row.source_object,
          object_row.target_object
      ), ''), 'UTF8')), 'hex')
      FROM ops.migration_objects object_row
    ) AS object_hash
)
SELECT format(
  $capsule$
DO $postcleanup_ops_precondition$
DECLARE
  cleanup_phase text;
  expected_cleanup_migrations text[];
  expected_cleanup_object_count bigint;
  actual_baseline_migration_count bigint;
  actual_baseline_migration_hash text;
  actual_baseline_object_count bigint;
  actual_baseline_object_hash text;
  actual_cleanup_migrations text[];
  actual_cleanup_object_count bigint;
BEGIN
  SELECT metadata ->> 'legacyDropPhase'
  INTO cleanup_phase
  FROM ops.migration_runs
  WHERE run_id = %L AND status = 'activated';

  IF cleanup_phase = 'reporting_and_rpcs_removed' THEN
    expected_cleanup_migrations := ARRAY['0091_drop_v2_reporting_and_rpcs.sql'];
    expected_cleanup_object_count := 1;
  ELSIF cleanup_phase = 'physical_objects_removed' THEN
    expected_cleanup_migrations := ARRAY[
      '0091_drop_v2_reporting_and_rpcs.sql',
      '0092_drop_v2_tables_partitions_triggers.sql'
    ];
    expected_cleanup_object_count := 5;
  ELSIF cleanup_phase = 'complete' THEN
    expected_cleanup_migrations := ARRAY[
      '0091_drop_v2_reporting_and_rpcs.sql',
      '0092_drop_v2_tables_partitions_triggers.sql',
      '0093_finalize_v3_migration_ownership.sql'
    ];
    expected_cleanup_object_count := 8;
  ELSE
    RAISE EXCEPTION 'post-cleanup rollback lost its exact cleanup phase';
  END IF;

  SELECT
    count(*)::bigint,
    encode(sha256(convert_to(coalesce(string_agg(
      to_jsonb(migration_row)::text,
      E'\n' ORDER BY migration_row.filename
    ), ''), 'UTF8')), 'hex')
  INTO actual_baseline_migration_count, actual_baseline_migration_hash
  FROM ops.schema_migrations migration_row
  WHERE migration_row.filename !~ '^009[1-3]_';

  SELECT array_agg(filename ORDER BY filename)
  INTO actual_cleanup_migrations
  FROM ops.schema_migrations
  WHERE filename ~ '^009[1-3]_';

  SELECT
    count(*)::bigint,
    encode(sha256(convert_to(coalesce(string_agg(
      to_jsonb(object_row)::text,
      E'\n' ORDER BY
        object_row.run_id,
        object_row.check_name,
        object_row.source_object,
        object_row.target_object
    ), ''), 'UTF8')), 'hex')
  INTO actual_baseline_object_count, actual_baseline_object_hash
  FROM ops.migration_objects object_row
  WHERE object_row.check_name !~ '^009[1-3]_';

  SELECT count(*) INTO actual_cleanup_object_count
  FROM ops.migration_objects
  WHERE check_name ~ '^009[1-3]_';

  IF actual_baseline_migration_count <> %s
     OR actual_baseline_migration_hash IS DISTINCT FROM %L
     OR actual_cleanup_migrations IS DISTINCT FROM expected_cleanup_migrations THEN
    RAISE EXCEPTION 'post-cleanup rollback found an unexpected schema-migration ledger change';
  END IF;

  IF actual_baseline_object_count <> %s
     OR actual_baseline_object_hash IS DISTINCT FROM %L
     OR actual_cleanup_object_count <> expected_cleanup_object_count
     OR EXISTS (
       SELECT 1
       FROM ops.migration_objects
       WHERE check_name ~ '^009[1-3]_'
         AND (
           run_id <> %L
           OR status <> 'passed'
           OR failed_count <> 0
           OR check_name NOT IN (
             '0091_drop_v2_reporting_and_rpcs',
             '0092_drop_v2_physical_relations',
             '0092_drop_v2_sequences',
             '0092_drop_v2_enum_types',
             '0092_drop_v2_public_fence_function',
             '0093_remove_v2_ledger_compatibility',
             '0093_remove_graphql_ddl_ledger',
             '0093_remove_v2_mutation_fence'
           )
         )
     ) THEN
    RAISE EXCEPTION 'post-cleanup rollback found an unexpected migration-object ledger change';
  END IF;
END
$postcleanup_ops_precondition$;
$capsule$,
  :'cutover_run_id',
  baseline.migration_count,
  baseline.migration_hash,
  baseline.object_count,
  baseline.object_hash,
  :'cutover_run_id'
)
FROM baseline;

SELECT format(
  'ALTER SCHEMA public OWNER TO %I;',
  pg_get_userbyid(namespace_row.nspowner)
)
FROM pg_namespace namespace_row
WHERE namespace_row.nspname = 'public';

-- PostgreSQL 15 pg_dump can treat PUBLIC USAGE as the schema ACL default even when a freshly
-- recreated public schema starts without it. Normalize every non-owner grantee, then replay the
-- exact B1 schema ACL before validating the captured security fingerprint.
SELECT $capsule$
DO $normalize_public_schema_acl$
DECLARE
  grantee_name text;
BEGIN
  FOR grantee_name IN
    SELECT CASE acl_row.grantee
      WHEN 0 THEN 'PUBLIC'
      ELSE quote_ident(pg_get_userbyid(acl_row.grantee))
    END
    FROM pg_namespace namespace_row
    CROSS JOIN LATERAL aclexplode(coalesce(
      namespace_row.nspacl,
      acldefault('n', namespace_row.nspowner)
    )) acl_row
    WHERE namespace_row.nspname = 'public'
      AND acl_row.grantee <> namespace_row.nspowner
    GROUP BY acl_row.grantee
  LOOP
    EXECUTE 'REVOKE ALL ON SCHEMA public FROM ' || grantee_name;
  END LOOP;
END
$normalize_public_schema_acl$;
$capsule$;

SELECT format(
  'GRANT %s ON SCHEMA public TO %s%s;',
  acl_row.privilege_type,
  CASE acl_row.grantee
    WHEN 0 THEN 'PUBLIC'
    ELSE quote_ident(pg_get_userbyid(acl_row.grantee))
  END,
  CASE WHEN acl_row.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
)
FROM pg_namespace namespace_row
CROSS JOIN LATERAL aclexplode(coalesce(
  namespace_row.nspacl,
  acldefault('n', namespace_row.nspowner)
)) acl_row
WHERE namespace_row.nspname = 'public'
  AND acl_row.grantee <> namespace_row.nspowner
ORDER BY acl_row.grantee, acl_row.privilege_type, acl_row.is_grantable;

WITH public_contract AS (
  SELECT
    (
      SELECT encode(sha256(convert_to(coalesce(string_agg(concat_ws(
        E'\x1f',
        relation_row.relkind::text,
        relation_row.relname,
        pg_get_userbyid(relation_row.relowner),
        relation_row.relispartition::text,
        relation_row.relpersistence::text,
        relation_row.relrowsecurity::text,
        relation_row.relforcerowsecurity::text
      ), E'\n' ORDER BY relation_row.relkind, relation_row.relname), ''), 'UTF8')), 'hex')
      FROM pg_class relation_row
      WHERE relation_row.relnamespace = 'public'::regnamespace
        AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')
    ) AS relation_hash,
    (
      SELECT encode(sha256(convert_to(coalesce(string_agg(concat_ws(
        E'\x1f',
        function_row.oid::regprocedure::text,
        pg_get_userbyid(function_row.proowner),
        pg_get_functiondef(function_row.oid),
        function_row.proacl::text,
        function_row.prosecdef::text,
        function_row.proconfig::text
      ), E'\n' ORDER BY function_row.oid::regprocedure::text), ''), 'UTF8')), 'hex')
      FROM pg_proc function_row
      WHERE function_row.pronamespace = 'public'::regnamespace
    ) AS function_hash,
    (
      SELECT encode(sha256(convert_to(coalesce(string_agg(concat_ws(
        E'\x1f',
        type_row.typname,
        pg_get_userbyid(type_row.typowner),
        type_row.typacl::text,
        enum_row.enumsortorder::text,
        enum_row.enumlabel
      ), E'\n' ORDER BY type_row.typname, enum_row.enumsortorder), ''), 'UTF8')), 'hex')
      FROM pg_type type_row
      JOIN pg_enum enum_row ON enum_row.enumtypid = type_row.oid
      WHERE type_row.typnamespace = 'public'::regnamespace
        AND type_row.typtype = 'e'
    ) AS enum_hash,
    (
      SELECT encode(sha256(convert_to(coalesce(string_agg(concat_ws(
        E'\x1f',
        relation_row.relname,
        trigger_row.tgname,
        trigger_row.tgenabled::text,
        pg_get_triggerdef(trigger_row.oid, false)
      ), E'\n' ORDER BY relation_row.relname, trigger_row.tgname), ''), 'UTF8')), 'hex')
      FROM pg_trigger trigger_row
      JOIN pg_class relation_row ON relation_row.oid = trigger_row.tgrelid
      WHERE relation_row.relnamespace = 'public'::regnamespace
        AND trigger_row.tgname = 'v3_reject_v2_mutation'
        AND NOT trigger_row.tgisinternal
    ) AS fence_hash,
    (
      SELECT encode(sha256(convert_to(concat_ws(
        E'\x1f',
        pg_get_userbyid(namespace_row.nspowner),
        namespace_row.nspacl::text
      ), 'UTF8')), 'hex')
      FROM pg_namespace namespace_row
      WHERE namespace_row.nspname = 'public'
    ) AS schema_hash,
    (
      SELECT encode(sha256(convert_to(concat_ws(
        E'\x1f',
        pg_get_functiondef(function_row.oid),
        pg_get_userbyid(function_row.proowner),
        function_row.proacl::text,
        function_row.proconfig::text
      ), 'UTF8')), 'hex')
      FROM pg_proc function_row
      WHERE function_row.oid = 'ops.reject_v2_mutation()'::regprocedure
    ) AS fence_function_hash
)
SELECT format(
  $capsule$
DO $postcleanup_public_restore_postcondition$
DECLARE
  actual_relation_hash text;
  actual_function_hash text;
  actual_enum_hash text;
  actual_fence_hash text;
  actual_schema_hash text;
  actual_fence_function_hash text;
BEGIN
  SELECT encode(sha256(convert_to(coalesce(string_agg(concat_ws(
    E'\x1f',
    relation_row.relkind::text,
    relation_row.relname,
    pg_get_userbyid(relation_row.relowner),
    relation_row.relispartition::text,
    relation_row.relpersistence::text,
    relation_row.relrowsecurity::text,
    relation_row.relforcerowsecurity::text
  ), E'\n' ORDER BY relation_row.relkind, relation_row.relname), ''), 'UTF8')), 'hex')
  INTO actual_relation_hash
  FROM pg_class relation_row
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S');

  SELECT encode(sha256(convert_to(coalesce(string_agg(concat_ws(
    E'\x1f',
    function_row.oid::regprocedure::text,
    pg_get_userbyid(function_row.proowner),
    pg_get_functiondef(function_row.oid),
    function_row.proacl::text,
    function_row.prosecdef::text,
    function_row.proconfig::text
  ), E'\n' ORDER BY function_row.oid::regprocedure::text), ''), 'UTF8')), 'hex')
  INTO actual_function_hash
  FROM pg_proc function_row
  WHERE function_row.pronamespace = 'public'::regnamespace;

  SELECT encode(sha256(convert_to(coalesce(string_agg(concat_ws(
    E'\x1f',
    type_row.typname,
    pg_get_userbyid(type_row.typowner),
    type_row.typacl::text,
    enum_row.enumsortorder::text,
    enum_row.enumlabel
  ), E'\n' ORDER BY type_row.typname, enum_row.enumsortorder), ''), 'UTF8')), 'hex')
  INTO actual_enum_hash
  FROM pg_type type_row
  JOIN pg_enum enum_row ON enum_row.enumtypid = type_row.oid
  WHERE type_row.typnamespace = 'public'::regnamespace
    AND type_row.typtype = 'e';

  SELECT encode(sha256(convert_to(coalesce(string_agg(concat_ws(
    E'\x1f',
    relation_row.relname,
    trigger_row.tgname,
    trigger_row.tgenabled::text,
    pg_get_triggerdef(trigger_row.oid, false)
  ), E'\n' ORDER BY relation_row.relname, trigger_row.tgname), ''), 'UTF8')), 'hex')
  INTO actual_fence_hash
  FROM pg_trigger trigger_row
  JOIN pg_class relation_row ON relation_row.oid = trigger_row.tgrelid
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND trigger_row.tgname = 'v3_reject_v2_mutation'
    AND NOT trigger_row.tgisinternal;

  SELECT encode(sha256(convert_to(concat_ws(
    E'\x1f',
    pg_get_userbyid(namespace_row.nspowner),
    namespace_row.nspacl::text
  ), 'UTF8')), 'hex')
  INTO actual_schema_hash
  FROM pg_namespace namespace_row
  WHERE namespace_row.nspname = 'public';

  SELECT encode(sha256(convert_to(concat_ws(
    E'\x1f',
    pg_get_functiondef(function_row.oid),
    pg_get_userbyid(function_row.proowner),
    function_row.proacl::text,
    function_row.proconfig::text
  ), 'UTF8')), 'hex')
  INTO actual_fence_function_hash
  FROM pg_proc function_row
  WHERE function_row.oid = 'ops.reject_v2_mutation()'::regprocedure;

  IF actual_relation_hash IS DISTINCT FROM %L
     OR actual_function_hash IS DISTINCT FROM %L
     OR actual_enum_hash IS DISTINCT FROM %L
     OR actual_fence_hash IS DISTINCT FROM %L
     OR actual_schema_hash IS DISTINCT FROM %L
     OR actual_fence_function_hash IS DISTINCT FROM %L THEN
    RAISE EXCEPTION 'B1 public restore differs from the captured object/security contract';
  END IF;

  IF (SELECT count(*) FROM pg_class relation_row
      WHERE relation_row.relnamespace = 'public'::regnamespace
        AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S'))
      <> 221 + CASE
        WHEN to_regclass('public.public_league_trends_catalog') IS NULL THEN 0
        ELSE 1
      END
     OR (SELECT count(*) FROM pg_proc function_row
         WHERE function_row.pronamespace = 'public'::regnamespace)
      <> 6 + CASE
        WHEN to_regclass('public.public_league_trends_catalog') IS NULL THEN 0
        ELSE 2
      END
     OR (SELECT count(*) FROM pg_type type_row
         WHERE type_row.typnamespace = 'public'::regnamespace
           AND type_row.typtype = 'e') <> 20
     OR (SELECT count(*) FROM pg_trigger trigger_row
         JOIN pg_class relation_row ON relation_row.oid = trigger_row.tgrelid
         WHERE relation_row.relnamespace = 'public'::regnamespace
           AND trigger_row.tgname = 'v3_reject_v2_mutation'
           AND NOT trigger_row.tgisinternal)
      <> 192 + CASE
        WHEN to_regclass('public.public_league_trends_catalog') IS NULL THEN 0
        ELSE 1
      END THEN
    RAISE EXCEPTION 'B1 public restore has an unexpected object cardinality';
  END IF;
END
$postcleanup_public_restore_postcondition$;
$capsule$,
  public_contract.relation_hash,
  public_contract.function_hash,
  public_contract.enum_hash,
  public_contract.fence_hash,
  public_contract.schema_hash,
  public_contract.fence_function_hash
)
FROM public_contract;

SELECT format(
  $capsule$
DELETE FROM ops.migration_objects
WHERE run_id = %L
  AND check_name IN (
    '0091_drop_v2_reporting_and_rpcs',
    '0092_drop_v2_physical_relations',
    '0092_drop_v2_sequences',
    '0092_drop_v2_enum_types',
    '0092_drop_v2_public_fence_function',
    '0093_remove_v2_ledger_compatibility',
    '0093_remove_graphql_ddl_ledger',
    '0093_remove_v2_mutation_fence'
  );

DELETE FROM ops.schema_migrations
WHERE filename IN (
  '0091_drop_v2_reporting_and_rpcs.sql',
  '0092_drop_v2_tables_partitions_triggers.sql',
  '0093_finalize_v3_migration_ownership.sql'
);

UPDATE ops.migration_runs
SET
  plan_version = %L,
  source_project = %L,
  source_postgres_version = %L,
  source_data_sha = %L,
  status = %L,
  started_at = %L::timestamptz,
  completed_at = %L::timestamptz,
  metadata = %L::jsonb,
  updated_at = %L::timestamptz
WHERE run_id = %L;
$capsule$,
  run_row.run_id,
  run_row.plan_version,
  run_row.source_project,
  run_row.source_postgres_version,
  run_row.source_data_sha,
  run_row.status,
  run_row.started_at,
  run_row.completed_at,
  run_row.metadata::text,
  run_row.updated_at,
  run_row.run_id
)
FROM ops.migration_runs run_row
WHERE run_row.run_id = :'cutover_run_id';

WITH baseline AS (
  SELECT
    (SELECT count(*) FROM ops.schema_migrations)::bigint AS migration_count,
    (
      SELECT encode(sha256(convert_to(coalesce(string_agg(
        to_jsonb(migration_row)::text,
        E'\n' ORDER BY migration_row.filename
      ), ''), 'UTF8')), 'hex')
      FROM ops.schema_migrations migration_row
    ) AS migration_hash,
    (SELECT count(*) FROM ops.migration_objects)::bigint AS object_count,
    (
      SELECT encode(sha256(convert_to(coalesce(string_agg(
        to_jsonb(object_row)::text,
        E'\n' ORDER BY
          object_row.run_id,
          object_row.check_name,
          object_row.source_object,
          object_row.target_object
      ), ''), 'UTF8')), 'hex')
      FROM ops.migration_objects object_row
    ) AS object_hash,
    (
      SELECT encode(sha256(convert_to(to_jsonb(run_row)::text, 'UTF8')), 'hex')
      FROM ops.migration_runs run_row
      WHERE run_row.run_id = :'cutover_run_id'
    ) AS run_hash
), captured_run AS (
  SELECT encode(sha256(convert_to(to_jsonb(run_row)::text, 'UTF8')), 'hex') AS run_hash
  FROM ops.migration_runs run_row
  WHERE run_row.run_id = :'cutover_run_id'
)
SELECT format(
  $capsule$
DO $postcleanup_ops_postcondition$
DECLARE
  actual_migration_count bigint;
  actual_migration_hash text;
  actual_object_count bigint;
  actual_object_hash text;
  actual_run_hash text;
BEGIN
  SELECT
    count(*)::bigint,
    encode(sha256(convert_to(coalesce(string_agg(
      to_jsonb(migration_row)::text,
      E'\n' ORDER BY migration_row.filename
    ), ''), 'UTF8')), 'hex')
  INTO actual_migration_count, actual_migration_hash
  FROM ops.schema_migrations migration_row;

  SELECT
    count(*)::bigint,
    encode(sha256(convert_to(coalesce(string_agg(
      to_jsonb(object_row)::text,
      E'\n' ORDER BY
        object_row.run_id,
        object_row.check_name,
        object_row.source_object,
        object_row.target_object
    ), ''), 'UTF8')), 'hex')
  INTO actual_object_count, actual_object_hash
  FROM ops.migration_objects object_row;

  SELECT encode(sha256(convert_to(to_jsonb(run_row)::text, 'UTF8')), 'hex')
  INTO actual_run_hash
  FROM ops.migration_runs run_row
  WHERE run_row.run_id = %L;

  IF actual_migration_count <> %s
     OR actual_migration_hash IS DISTINCT FROM %L
     OR actual_object_count <> %s
     OR actual_object_hash IS DISTINCT FROM %L
     OR actual_run_hash IS DISTINCT FROM %L
     OR EXISTS (SELECT 1 FROM ops.schema_migrations WHERE filename ~ '^009[1-3]_')
     OR EXISTS (SELECT 1 FROM ops.migration_objects WHERE check_name ~ '^009[1-3]_') THEN
    RAISE EXCEPTION 'post-cleanup rollback did not restore the exact B1 ops state';
  END IF;
END
$postcleanup_ops_postcondition$;
$capsule$,
  :'cutover_run_id',
  baseline.migration_count,
  baseline.migration_hash,
  baseline.object_count,
  baseline.object_hash,
  baseline.run_hash
)
FROM baseline
CROSS JOIN captured_run;

SELECT 'COMMIT;';
SELECT
  'SELECT ''postcleanup_rollback_post_passed'' AS status, '
  || 'current_database() AS database_name;';

\endif
