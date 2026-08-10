\set ON_ERROR_STOP on

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '10s';

\pset tuples_only off
\pset format csv

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
  ) AS fence_function_hash;

COMMIT;
