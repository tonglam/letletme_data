\set ON_ERROR_STOP on
\o /dev/null
\set QUIET 1
\pset tuples_only on
\pset format unaligned
\pset pager off
\unset QUIET

-- Usage:
--   psql -v cutover_run_id=v3-... \
--     -f sql/v3/generate-preactivation-rollback.sql \
--     > preactivation-rollback.sql
-- Generate after the final B0 preflight and before 0079. This capsule restores
-- the exact public v2 ledger and ACL surface if activation has not begun. It
-- deliberately retains inert private v3 staging schemas so a diagnosed retry
-- can reuse deterministic conversion output without touching v2 business data.

SELECT :'cutover_run_id'::text;
SELECT set_config('letletme.v3_preactivation_rollback_run_id', :'cutover_run_id', false);

DO $generator_preflight$
DECLARE
  run_id text := current_setting('letletme.v3_preactivation_rollback_run_id', true);
BEGIN
  IF run_id !~ '^v3-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,12}$' THEN
    RAISE EXCEPTION 'invalid cutover run ID for preactivation rollback capsule';
  END IF;

  IF current_setting('server_version_num')::integer / 10000 <> 15 THEN
    RAISE EXCEPTION 'preactivation rollback capsule requires PostgreSQL 15';
  END IF;

  IF (SELECT count(*) FROM pg_class relation_row
      WHERE relation_row.relnamespace = 'public'::regnamespace
        AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')) <> 220
     OR (SELECT count(*) FROM pg_proc function_row
         WHERE function_row.pronamespace = 'public'::regnamespace) <> 6
     OR (SELECT count(*) FROM pg_type type_row
         WHERE type_row.typnamespace = 'public'::regnamespace
           AND type_row.typtype = 'e') <> 20 THEN
    RAISE EXCEPTION 'public source scope differs from the P0-approved rollback contract';
  END IF;

  IF to_regclass('public.sql_migrations') IS NULL
     OR (SELECT relation_row.relkind
         FROM pg_class relation_row
         WHERE relation_row.oid = 'public.sql_migrations'::regclass) <> 'r' THEN
    RAISE EXCEPTION 'preactivation rollback generator requires the v2 ledger table';
  END IF;
END
$generator_preflight$;
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
SELECT 'BEGIN;';
SELECT 'SET LOCAL lock_timeout = ''5s'';';
SELECT 'SET LOCAL statement_timeout = ''10min'';';
SELECT 'SELECT pg_advisory_xact_lock(912883475);';
SELECT
  'SELECT set_config(''letletme.v3_preactivation_rollback_approval'', '
  || ':''rollback_approval'', true);';

WITH baseline_ledger AS (
  SELECT
    count(*)::bigint AS row_count,
    md5(coalesce(
      string_agg(to_jsonb(migration_row)::text, E'\n' ORDER BY migration_row.filename),
      ''
    )) AS content_hash,
    string_agg(format('%L', migration_row.filename), ', ' ORDER BY migration_row.filename)
      AS filename_literals
  FROM public.sql_migrations migration_row
)
SELECT format(
  $capsule$
DO $preactivation_rollback_preflight$
DECLARE
  approval text := current_setting('letletme.v3_preactivation_rollback_approval', true);
  baseline_count bigint;
  baseline_hash text;
BEGIN
  IF approval IS DISTINCT FROM %L THEN
    RAISE EXCEPTION 'preactivation rollback approval does not match this capsule';
  END IF;
  IF current_setting('server_version_num')::integer / 10000 <> 15 THEN
    RAISE EXCEPTION 'preactivation rollback requires PostgreSQL 15';
  END IF;
  IF to_regclass('ops.migration_runs') IS NULL
     OR (SELECT status FROM ops.migration_runs WHERE run_id = %L)
        NOT IN ('running', 'validated') THEN
    RAISE EXCEPTION 'preactivation rollback requires a running or validated migration run';
  END IF;
  IF EXISTS (
    SELECT 1 FROM ops.migration_runs
    WHERE run_id = %L AND metadata ? 'legacyDropPhase'
  ) THEN
    RAISE EXCEPTION 'preactivation rollback cannot run after legacy cleanup begins';
  END IF;
  IF EXISTS (SELECT 1 FROM ops.dataset_publications WHERE status = 'active') THEN
    RAISE EXCEPTION 'preactivation rollback cannot run after v3 publication activation';
  END IF;
  IF to_regclass('public.sql_migrations_v2') IS NOT NULL
     OR (SELECT relation_row.relkind
         FROM pg_class relation_row
         WHERE relation_row.oid = 'public.sql_migrations'::regclass) <> 'r' THEN
    RAISE EXCEPTION 'preactivation rollback requires the original v2 ledger table';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    JOIN pg_class relation_row ON relation_row.oid = trigger_row.tgrelid
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND trigger_row.tgname = 'v3_reject_v2_mutation'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'preactivation rollback found an activated v2 mutation fence';
  END IF;

  SELECT
    count(*)::bigint,
    md5(coalesce(
      string_agg(to_jsonb(migration_row)::text, E'\n' ORDER BY migration_row.filename),
      ''
    ))
  INTO baseline_count, baseline_hash
  FROM public.sql_migrations migration_row
  WHERE migration_row.filename IN (%s);

  IF baseline_count <> %s OR baseline_hash IS DISTINCT FROM %L THEN
    RAISE EXCEPTION 'preactivation rollback baseline v2 ledger changed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.sql_migrations migration_row
    WHERE migration_row.filename NOT IN (%s)
      AND migration_row.filename NOT IN (
        '0079_create_v3_ops_and_roles.sql',
        '0080_create_v3_fpl_dimensions.sql',
        '0081_create_v3_fpl_facts.sql',
        '0082_create_v3_competition.sql',
        '0083_create_v3_understat_bridge.sql',
        '0084_create_v3_reporting.sql',
        '0085_migrate_v3_fpl_data.sql',
        '0086_migrate_v3_competition_data.sql',
        '0087_migrate_v3_understat_ops_data.sql',
        '0088_validate_v3_constraints.sql',
        '0089_prepare_v3_publications.sql'
      )
  ) THEN
    RAISE EXCEPTION 'preactivation rollback found an unapproved ledger entry';
  END IF;
END
$preactivation_rollback_preflight$;
$capsule$,
  'APPROVE_V3_PREACTIVATION_ROLLBACK ' || :'cutover_run_id',
  :'cutover_run_id',
  :'cutover_run_id',
  baseline_ledger.filename_literals,
  baseline_ledger.row_count,
  baseline_ledger.content_hash,
  baseline_ledger.filename_literals
)
FROM baseline_ledger;

SELECT format(
  'REVOKE ALL PRIVILEGES ON %s public.%I FROM letletme_data_owner;',
  CASE relation_row.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
  relation_row.relname
)
FROM pg_class relation_row
WHERE relation_row.relnamespace = 'public'::regnamespace
  AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')
ORDER BY relation_row.relkind, relation_row.relname;

SELECT 'REVOKE USAGE ON SCHEMA public FROM letletme_data_owner;';

WITH baseline_ledger AS (
  SELECT string_agg(format('%L', migration_row.filename), ', ' ORDER BY migration_row.filename)
    AS filename_literals
  FROM public.sql_migrations migration_row
)
SELECT format(
  'DELETE FROM public.sql_migrations WHERE filename NOT IN (%s);',
  baseline_ledger.filename_literals
)
FROM baseline_ledger;

SELECT format(
  $capsule$
UPDATE ops.migration_runs
SET updated_at = now(),
    metadata = metadata || jsonb_build_object(
      'preactivationRollbackAt', now(),
      'preactivationRollbackMode', 'public-v2-contract-restored'
    )
WHERE run_id = %L
  AND status IN ('running', 'validated');
$capsule$,
  :'cutover_run_id'
);

WITH expected_ledger AS (
  SELECT
    count(*)::bigint AS row_count,
    md5(coalesce(
      string_agg(to_jsonb(migration_row)::text, E'\n' ORDER BY migration_row.filename),
      ''
    )) AS content_hash
  FROM public.sql_migrations migration_row
)
SELECT format(
  $capsule$
DO $preactivation_rollback_postcondition$
DECLARE
  actual_count bigint;
  actual_hash text;
BEGIN
  SELECT
    count(*)::bigint,
    md5(coalesce(
      string_agg(to_jsonb(migration_row)::text, E'\n' ORDER BY migration_row.filename),
      ''
    ))
  INTO actual_count, actual_hash
  FROM public.sql_migrations migration_row;

  IF actual_count <> %s OR actual_hash IS DISTINCT FROM %L THEN
    RAISE EXCEPTION 'preactivation rollback did not restore the exact v2 ledger';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class relation_row
    CROSS JOIN LATERAL aclexplode(relation_row.relacl) acl_row
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')
      AND acl_row.grantee = 'letletme_data_owner'::regrole
  ) OR EXISTS (
    SELECT 1
    FROM pg_namespace namespace_row
    CROSS JOIN LATERAL aclexplode(namespace_row.nspacl) acl_row
    WHERE namespace_row.nspname = 'public'
      AND acl_row.grantee = 'letletme_data_owner'::regrole
      AND acl_row.privilege_type = 'USAGE'
  ) THEN
    RAISE EXCEPTION 'preactivation rollback left a v3 staging grant on public';
  END IF;
  IF EXISTS (SELECT 1 FROM ops.dataset_publications WHERE status = 'active') THEN
    RAISE EXCEPTION 'preactivation rollback left an active v3 publication';
  END IF;
END
$preactivation_rollback_postcondition$;
$capsule$,
  expected_ledger.row_count,
  expected_ledger.content_hash
)
FROM expected_ledger;

SELECT 'COMMIT;';
SELECT
  'SELECT ''preactivation_rollback_passed'' AS status, current_database() AS database_name;';
