\set ON_ERROR_STOP on
\o /dev/null
\set QUIET 1
\pset tuples_only on
\pset format unaligned
\pset pager off
\unset QUIET

-- Usage:
--   psql -v cutover_run_id=v3-... -f sql/v3/generate-activation-rollback.sql \
--     > activation-rollback.sql
-- Generate after the final B0 preflight and before 0079. Encrypt the capsule
-- immediately; it contains no passwords but is a privileged recovery command.

SELECT :'cutover_run_id'::text;
SELECT set_config('letletme.v3_rollback_capsule_run_id', :'cutover_run_id', false);

DO $generator_preflight$
DECLARE
  run_id text := current_setting('letletme.v3_rollback_capsule_run_id', true);
BEGIN
  IF run_id !~ '^v3-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,12}$' THEN
    RAISE EXCEPTION 'invalid cutover run ID for activation rollback capsule';
  END IF;

  IF current_setting('server_version_num')::integer / 10000 <> 15 THEN
    RAISE EXCEPTION 'activation rollback capsule requires PostgreSQL 15';
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

  IF EXISTS (
    SELECT 1
    FROM pg_class relation_row
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')
      AND relation_row.relowner <> (SELECT oid FROM pg_roles WHERE rolname = session_user)
  ) OR EXISTS (
    SELECT 1
    FROM pg_proc function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proowner <> (SELECT oid FROM pg_roles WHERE rolname = session_user)
  ) OR EXISTS (
    SELECT 1
    FROM pg_type type_row
    WHERE type_row.typnamespace = 'public'::regnamespace
      AND type_row.typtype = 'e'
      AND type_row.typowner <> (SELECT oid FROM pg_roles WHERE rolname = session_user)
  ) THEN
    RAISE EXCEPTION 'rollback capsule requires the one-owner activation preflight contract';
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
SELECT 'SELECT pg_advisory_xact_lock(912883474);';
SELECT
  'SELECT set_config(''letletme.v3_activation_rollback_approval'', '
  || ':''rollback_approval'', true);';

SELECT format(
  $capsule$
DO $rollback_preflight$
DECLARE
  approval text := current_setting('letletme.v3_activation_rollback_approval', true);
BEGIN
  IF approval IS DISTINCT FROM %L THEN
    RAISE EXCEPTION 'activation rollback approval does not match this capsule';
  END IF;
  IF current_setting('server_version_num')::integer / 10000 <> 15 THEN
    RAISE EXCEPTION 'activation rollback requires PostgreSQL 15';
  END IF;
  IF (SELECT status FROM ops.migration_runs WHERE run_id = %L) <> 'activated' THEN
    RAISE EXCEPTION 'activation rollback requires one activated migration run';
  END IF;
  IF EXISTS (
    SELECT 1 FROM ops.migration_runs
    WHERE run_id = %L AND metadata ? 'legacyDropPhase'
  ) THEN
    RAISE EXCEPTION 'activation rollback capsule cannot run after legacy cleanup begins';
  END IF;
  IF (SELECT count(*) FROM ops.dataset_publications WHERE status = 'active') <> 1 THEN
    RAISE EXCEPTION 'activation rollback requires exactly one active v3 publication';
  END IF;
  IF to_regclass('public.sql_migrations_v2') IS NULL
     OR to_regclass('public.sql_migrations') IS NULL THEN
    RAISE EXCEPTION 'activation ledger compatibility boundary is missing';
  END IF;
END
$rollback_preflight$;
$capsule$,
  'APPROVE_V3_ACTIVATION_ROLLBACK ' || :'cutover_run_id',
  :'cutover_run_id',
  :'cutover_run_id'
);

SELECT format(
  $capsule$
SET LOCAL ROLE letletme_data_owner;
UPDATE ops.dataset_publications
SET status = 'retired',
    retired_at = now(),
    updated_at = now(),
    manifest = jsonb_set(manifest, '{state}', '"retired"'::jsonb, true)
WHERE status = 'active';
UPDATE ops.migration_runs
SET status = 'rolled_back',
    completed_at = now(),
    updated_at = now(),
    metadata = metadata || jsonb_build_object(
      'activationRollbackAt', now(),
      'activationRollbackMode', 'captured-v2-contract'
    )
WHERE run_id = %L AND status = 'activated';
RESET ROLE;
$capsule$,
  :'cutover_run_id'
);

SELECT format(
  'DROP TRIGGER IF EXISTS v3_reject_v2_mutation ON public.%I;',
  CASE relation_row.relname
    WHEN 'sql_migrations' THEN 'sql_migrations_v2'
    ELSE relation_row.relname
  END
)
FROM pg_class relation_row
WHERE relation_row.relnamespace = 'public'::regnamespace
  AND relation_row.relkind IN ('r', 'p')
ORDER BY relation_row.relname;

SELECT 'DROP VIEW public.sql_migrations;';
SELECT 'ALTER TABLE public.sql_migrations_v2 RENAME TO sql_migrations;';

-- The v2 runner reads public.sql_migrations. Restore its exact pre-v3
-- filename set so the recorded old SHA cannot observe unknown v3 files.
SELECT format(
  'DELETE FROM public.sql_migrations WHERE filename NOT IN (%s);',
  string_agg(format('%L', migration_row.filename), ', ' ORDER BY migration_row.filename)
)
FROM public.sql_migrations migration_row;

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
DO $rollback_ledger_postcondition$
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
    RAISE EXCEPTION 'activation rollback did not restore the exact v2 migration ledger';
  END IF;
END
$rollback_ledger_postcondition$;
$capsule$,
  expected_ledger.row_count,
  expected_ledger.content_hash
)
FROM expected_ledger;

-- 0079 grants this private NOLOGIN owner read access to the legacy source for
-- conversion. Activation removes the relation grants; remove the remaining
-- schema grant before handing the database back to the v2 services.
SELECT 'REVOKE USAGE ON SCHEMA public FROM letletme_data_owner;';

SELECT format(
  'ALTER %s public.%I OWNER TO %I;',
  CASE relation_row.relkind
    WHEN 'm' THEN 'MATERIALIZED VIEW'
    WHEN 'v' THEN 'VIEW'
    ELSE 'TABLE'
  END,
  relation_row.relname,
  pg_get_userbyid(relation_row.relowner)
)
FROM pg_class relation_row
WHERE relation_row.relnamespace = 'public'::regnamespace
  AND relation_row.relkind IN ('r', 'p', 'm', 'v')
ORDER BY
  CASE relation_row.relkind
    WHEN 'p' THEN 0
    WHEN 'r' THEN 1
    WHEN 'm' THEN 2
    ELSE 3
  END,
  relation_row.relname;

-- Identity/serial sequences follow their owning table. Emit ALTER only for
-- independent sequences so the capsule cannot try to transfer a linked
-- sequence before PostgreSQL has restored its table owner.
SELECT format(
  'ALTER SEQUENCE public.%I OWNER TO %I;',
  relation_row.relname,
  pg_get_userbyid(relation_row.relowner)
)
FROM pg_class relation_row
WHERE relation_row.relnamespace = 'public'::regnamespace
  AND relation_row.relkind = 'S'
  AND NOT EXISTS (
    SELECT 1
    FROM pg_depend dependency_row
    WHERE dependency_row.classid = 'pg_class'::regclass
      AND dependency_row.objid = relation_row.oid
      AND dependency_row.refclassid = 'pg_class'::regclass
      AND dependency_row.deptype IN ('a', 'i')
  )
ORDER BY relation_row.relname;

SELECT format(
  'ALTER FUNCTION %s OWNER TO %I;',
  function_row.oid::regprocedure,
  pg_get_userbyid(function_row.proowner)
)
FROM pg_proc function_row
WHERE function_row.pronamespace = 'public'::regnamespace
ORDER BY function_row.oid::regprocedure::text;

SELECT format(
  'ALTER TYPE public.%I OWNER TO %I;',
  type_row.typname,
  pg_get_userbyid(type_row.typowner)
)
FROM pg_type type_row
WHERE type_row.typnamespace = 'public'::regnamespace
  AND type_row.typtype = 'e'
ORDER BY type_row.typname;

SELECT format(
  'GRANT %s ON %s public.%I TO %s%s;',
  acl_row.privilege_type,
  CASE relation_row.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
  relation_row.relname,
  CASE acl_row.grantee
    WHEN 0 THEN 'PUBLIC'
    ELSE quote_ident(pg_get_userbyid(acl_row.grantee))
  END,
  CASE WHEN acl_row.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
)
FROM pg_class relation_row
CROSS JOIN LATERAL aclexplode(relation_row.relacl) acl_row
WHERE relation_row.relnamespace = 'public'::regnamespace
  AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')
  AND acl_row.grantee <> relation_row.relowner
ORDER BY relation_row.relkind, relation_row.relname, acl_row.grantee, acl_row.privilege_type;

WITH expected_security AS (
  SELECT
    (
      SELECT pg_get_userbyid(relation_row.relowner)
      FROM pg_class relation_row
      WHERE relation_row.relnamespace = 'public'::regnamespace
        AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')
      ORDER BY relation_row.oid
      LIMIT 1
    ) AS owner_name,
    (
      SELECT md5(coalesce(string_agg(
        concat_ws(
          E'\x1f',
          relation_row.relkind::text,
          relation_row.relname,
          coalesce(pg_get_userbyid(acl_row.grantee), 'PUBLIC'),
          acl_row.privilege_type,
          acl_row.is_grantable::text
        ),
        E'\n' ORDER BY
          relation_row.relkind,
          relation_row.relname,
          acl_row.grantee,
          acl_row.privilege_type,
          acl_row.is_grantable
      ), ''))
      FROM pg_class relation_row
      CROSS JOIN LATERAL aclexplode(coalesce(
        relation_row.relacl,
        acldefault(
          CASE WHEN relation_row.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
          relation_row.relowner
        )
      )) acl_row
      WHERE relation_row.relnamespace = 'public'::regnamespace
        AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')
        AND acl_row.grantee <> relation_row.relowner
    ) AS relation_acl_hash,
    (
      SELECT md5(coalesce(string_agg(
        concat_ws(
          E'\x1f',
          coalesce(pg_get_userbyid(acl_row.grantee), 'PUBLIC'),
          acl_row.privilege_type,
          acl_row.is_grantable::text
        ),
        E'\n' ORDER BY acl_row.grantee, acl_row.privilege_type, acl_row.is_grantable
      ), ''))
      FROM pg_namespace namespace_row
      CROSS JOIN LATERAL aclexplode(coalesce(
        namespace_row.nspacl,
        acldefault('n', namespace_row.nspowner)
      )) acl_row
      WHERE namespace_row.nspname = 'public'
        AND acl_row.grantee <> namespace_row.nspowner
    ) AS schema_acl_hash
)
SELECT format(
  $capsule$
DO $rollback_security_postcondition$
DECLARE
  actual_relation_acl_hash text;
  actual_schema_acl_hash text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class relation_row
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')
      AND relation_row.relowner <> %L::regrole
  ) OR EXISTS (
    SELECT 1
    FROM pg_proc function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proowner <> %L::regrole
  ) OR EXISTS (
    SELECT 1
    FROM pg_type type_row
    WHERE type_row.typnamespace = 'public'::regnamespace
      AND type_row.typtype = 'e'
      AND type_row.typowner <> %L::regrole
  ) THEN
    RAISE EXCEPTION 'activation rollback did not restore the exact public owner';
  END IF;

  SELECT md5(coalesce(string_agg(
    concat_ws(
      E'\x1f',
      relation_row.relkind::text,
      relation_row.relname,
      coalesce(pg_get_userbyid(acl_row.grantee), 'PUBLIC'),
      acl_row.privilege_type,
      acl_row.is_grantable::text
    ),
    E'\n' ORDER BY
      relation_row.relkind,
      relation_row.relname,
      acl_row.grantee,
      acl_row.privilege_type,
      acl_row.is_grantable
  ), ''))
  INTO actual_relation_acl_hash
  FROM pg_class relation_row
  CROSS JOIN LATERAL aclexplode(coalesce(
    relation_row.relacl,
    acldefault(
      CASE WHEN relation_row.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
      relation_row.relowner
    )
  )) acl_row
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')
    AND acl_row.grantee <> relation_row.relowner;

  SELECT md5(coalesce(string_agg(
    concat_ws(
      E'\x1f',
      coalesce(pg_get_userbyid(acl_row.grantee), 'PUBLIC'),
      acl_row.privilege_type,
      acl_row.is_grantable::text
    ),
    E'\n' ORDER BY acl_row.grantee, acl_row.privilege_type, acl_row.is_grantable
  ), ''))
  INTO actual_schema_acl_hash
  FROM pg_namespace namespace_row
  CROSS JOIN LATERAL aclexplode(coalesce(
    namespace_row.nspacl,
    acldefault('n', namespace_row.nspowner)
  )) acl_row
  WHERE namespace_row.nspname = 'public'
    AND acl_row.grantee <> namespace_row.nspowner;

  IF actual_relation_acl_hash IS DISTINCT FROM %L
     OR actual_schema_acl_hash IS DISTINCT FROM %L THEN
    RAISE EXCEPTION 'activation rollback did not restore the exact public ACL contract';
  END IF;
END
$rollback_security_postcondition$;
$capsule$,
  expected_security.owner_name,
  expected_security.owner_name,
  expected_security.owner_name,
  expected_security.relation_acl_hash,
  expected_security.schema_acl_hash
)
FROM expected_security;

SELECT format(
  $capsule$
DO $rollback_postcondition$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class relation_row
    JOIN pg_trigger trigger_row ON trigger_row.tgrelid = relation_row.oid
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND trigger_row.tgname = 'v3_reject_v2_mutation'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'activation rollback left a v2 mutation fence';
  END IF;
  IF to_regclass('public.sql_migrations_v2') IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_class relation_row
       WHERE relation_row.oid = 'public.sql_migrations'::regclass
         AND relation_row.relkind IN ('r', 'p')
     ) THEN
    RAISE EXCEPTION 'activation rollback did not restore the v2 ledger table';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class relation_row
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')
      AND relation_row.relowner = 'letletme_v2_frozen_owner'::regrole
  ) OR EXISTS (
    SELECT 1 FROM pg_proc function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proowner = 'letletme_v2_frozen_owner'::regrole
  ) OR EXISTS (
    SELECT 1 FROM pg_type type_row
    WHERE type_row.typnamespace = 'public'::regnamespace
      AND type_row.typtype = 'e'
      AND type_row.typowner = 'letletme_v2_frozen_owner'::regrole
  ) THEN
    RAISE EXCEPTION 'activation rollback left a public object frozen';
  END IF;
  IF EXISTS (SELECT 1 FROM ops.dataset_publications WHERE status = 'active')
     OR (SELECT status FROM ops.migration_runs WHERE run_id = %L) <> 'rolled_back' THEN
    RAISE EXCEPTION 'activation rollback did not retire v3 authority';
  END IF;
END
$rollback_postcondition$;
$capsule$,
  :'cutover_run_id'
);

SELECT 'COMMIT;';
SELECT
  'SELECT ''activation_rollback_passed'' AS status, '
  || 'current_database() AS database_name;';
