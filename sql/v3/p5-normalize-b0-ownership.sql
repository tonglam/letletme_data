\set ON_ERROR_STOP on
\if :{?target_owner}
\else
\echo target_owner is required
\quit 3
\endif

-- pg_restore --no-owner assigns B0 objects to the local restore login, while a
-- Supabase image can retain supabase_admin ownership for application schemas
-- already present in its template. P5 normalizes only an isolated p5_* database
-- to the exact production B0 owner before Web or Data migrations run.

BEGIN;

SET statement_timeout = '5min';
SET lock_timeout = '5s';
SELECT set_config('letletme.p5_target_owner', :'target_owner', false);

DO $safety_contract$
DECLARE
  public_enum_count bigint;
  public_function_count bigint;
  public_relation_count bigint;
  bauth_relation_count bigint;
  fpl_relation_count bigint;
  wechat_relation_count bigint;
  target_owner_name text := current_setting('letletme.p5_target_owner', true);
BEGIN
  IF current_database() !~ '^p5_' THEN
    RAISE EXCEPTION 'P5 ownership normalization requires an isolated p5_* database';
  END IF;

  SELECT count(*) INTO public_relation_count
  FROM pg_class relation_row
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S');

  SELECT count(*) INTO public_function_count
  FROM pg_proc function_row
  WHERE function_row.pronamespace = 'public'::regnamespace;

  SELECT count(*) INTO public_enum_count
  FROM pg_type type_row
  WHERE type_row.typnamespace = 'public'::regnamespace
    AND type_row.typtype = 'e';

  IF public_relation_count <> 220
     OR public_function_count <> 6
     OR public_enum_count <> 20 THEN
    RAISE EXCEPTION
      'P5 B0 scope mismatch: relations=%, functions=%, enums=%',
      public_relation_count,
      public_function_count,
      public_enum_count;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_owner_name) THEN
    RAISE EXCEPTION 'P5 target owner role % does not exist', target_owner_name;
  END IF;

  IF target_owner_name <> 'postgres' THEN
    RAISE EXCEPTION 'P5 B0 target owner must be the direct Supabase postgres role';
  END IF;

  IF to_regnamespace('bauth') IS NULL
     OR to_regnamespace('fpl') IS NULL
     OR to_regnamespace('wechat') IS NULL THEN
    RAISE EXCEPTION 'P5 B0 source application schemas are incomplete';
  END IF;

  SELECT count(*) INTO bauth_relation_count
  FROM pg_class relation_row
  WHERE relation_row.relnamespace = 'bauth'::regnamespace
    AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S');

  SELECT count(*) INTO wechat_relation_count
  FROM pg_class relation_row
  WHERE relation_row.relnamespace = 'wechat'::regnamespace
    AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S');

  SELECT count(*) INTO fpl_relation_count
  FROM pg_class relation_row
  WHERE relation_row.relnamespace = 'fpl'::regnamespace
    AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S');

  IF bauth_relation_count <> 13 OR fpl_relation_count <> 0 OR wechat_relation_count <> 4 THEN
    RAISE EXCEPTION
      'P5 B0 source scope mismatch: bauth relations=%, fpl relations=%, wechat relations=%',
      bauth_relation_count,
      fpl_relation_count,
      wechat_relation_count;
  END IF;
END
$safety_contract$;

DO $normalize_application_schemas$
DECLARE
  schema_name text;
  target_owner_name text := current_setting('letletme.p5_target_owner', true);
BEGIN
  FOREACH schema_name IN ARRAY ARRAY['bauth', 'fpl', 'wechat']
  LOOP
    IF (SELECT nspowner FROM pg_namespace WHERE nspname = schema_name)
       <> (SELECT oid FROM pg_roles WHERE rolname = target_owner_name) THEN
      EXECUTE format('ALTER SCHEMA %I OWNER TO %I', schema_name, target_owner_name);
    END IF;
  END LOOP;
END
$normalize_application_schemas$;

DO $normalize_application_relations$
DECLARE
  relation_record record;
  alter_kind text;
  target_owner_name text := current_setting('letletme.p5_target_owner', true);
BEGIN
  FOR relation_record IN
    SELECT namespace_row.nspname, relation_row.relname, relation_row.relkind
    FROM pg_class relation_row
    JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
    WHERE namespace_row.nspname IN ('bauth', 'fpl', 'wechat')
      AND relation_row.relkind IN ('r', 'p', 'm', 'v')
      AND relation_row.relowner <> (SELECT oid FROM pg_roles WHERE rolname = target_owner_name)
    ORDER BY namespace_row.nspname, relation_row.relkind, relation_row.relname
  LOOP
    alter_kind := CASE relation_record.relkind
      WHEN 'm' THEN 'MATERIALIZED VIEW'
      WHEN 'v' THEN 'VIEW'
      ELSE 'TABLE'
    END;
    EXECUTE format(
      'ALTER %s %I.%I OWNER TO %I',
      alter_kind,
      relation_record.nspname,
      relation_record.relname,
      target_owner_name
    );
  END LOOP;
END
$normalize_application_relations$;

-- Owned identity/serial sequences follow their table owner automatically.
-- Re-query after table ownership changes and alter only independent leftovers.
DO $normalize_application_sequences$
DECLARE
  sequence_record record;
  target_owner_name text := current_setting('letletme.p5_target_owner', true);
BEGIN
  FOR sequence_record IN
    SELECT namespace_row.nspname, relation_row.relname
    FROM pg_class relation_row
    JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
    WHERE namespace_row.nspname IN ('bauth', 'fpl', 'wechat')
      AND relation_row.relkind = 'S'
      AND relation_row.relowner <> (SELECT oid FROM pg_roles WHERE rolname = target_owner_name)
    ORDER BY namespace_row.nspname, relation_row.relname
  LOOP
    EXECUTE format(
      'ALTER SEQUENCE %I.%I OWNER TO %I',
      sequence_record.nspname,
      sequence_record.relname,
      target_owner_name
    );
  END LOOP;
END
$normalize_application_sequences$;

DO $normalize_public_relations$
DECLARE
  relation_record record;
  alter_kind text;
  target_owner_name text := current_setting('letletme.p5_target_owner', true);
BEGIN
  FOR relation_record IN
    SELECT relation_row.relname, relation_row.relkind
    FROM pg_class relation_row
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND relation_row.relkind IN ('r', 'p', 'm', 'v')
      AND relation_row.relowner <> (SELECT oid FROM pg_roles WHERE rolname = target_owner_name)
    ORDER BY relation_row.relkind, relation_row.relname
  LOOP
    alter_kind := CASE relation_record.relkind
      WHEN 'm' THEN 'MATERIALIZED VIEW'
      WHEN 'v' THEN 'VIEW'
      ELSE 'TABLE'
    END;
    EXECUTE format(
      'ALTER %s public.%I OWNER TO %I',
      alter_kind,
      relation_record.relname,
      target_owner_name
    );
  END LOOP;
END
$normalize_public_relations$;

-- Owned identity/serial sequences follow their table owner automatically.
-- Re-query afterward and alter only any independent sequence that remains.
DO $normalize_public_sequences$
DECLARE
  sequence_record record;
  target_owner_name text := current_setting('letletme.p5_target_owner', true);
BEGIN
  FOR sequence_record IN
    SELECT relation_row.relname
    FROM pg_class relation_row
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND relation_row.relkind = 'S'
      AND relation_row.relowner <> (SELECT oid FROM pg_roles WHERE rolname = target_owner_name)
    ORDER BY relation_row.relname
  LOOP
    EXECUTE format(
      'ALTER SEQUENCE public.%I OWNER TO %I',
      sequence_record.relname,
      target_owner_name
    );
  END LOOP;
END
$normalize_public_sequences$;

DO $normalize_public_functions$
DECLARE
  function_record record;
  target_owner_name text := current_setting('letletme.p5_target_owner', true);
BEGIN
  FOR function_record IN
    SELECT function_row.oid
    FROM pg_proc function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proowner <> (SELECT oid FROM pg_roles WHERE rolname = target_owner_name)
    ORDER BY function_row.oid::regprocedure::text
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %s OWNER TO %I',
      function_record.oid::regprocedure,
      target_owner_name
    );
  END LOOP;
END
$normalize_public_functions$;

DO $normalize_public_enums$
DECLARE
  type_record record;
  target_owner_name text := current_setting('letletme.p5_target_owner', true);
BEGIN
  FOR type_record IN
    SELECT type_row.typname
    FROM pg_type type_row
    WHERE type_row.typnamespace = 'public'::regnamespace
      AND type_row.typtype = 'e'
      AND type_row.typowner <> (SELECT oid FROM pg_roles WHERE rolname = target_owner_name)
    ORDER BY type_row.typname
  LOOP
    EXECUTE format('ALTER TYPE public.%I OWNER TO %I', type_record.typname, target_owner_name);
  END LOOP;
END
$normalize_public_enums$;

DO $postcondition$
DECLARE
  target_owner_name text := current_setting('letletme.p5_target_owner', true);
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class relation_row
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')
      AND relation_row.relowner <> (SELECT oid FROM pg_roles WHERE rolname = target_owner_name)
  ) OR EXISTS (
    SELECT 1
    FROM pg_proc function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proowner <> (SELECT oid FROM pg_roles WHERE rolname = target_owner_name)
  ) OR EXISTS (
    SELECT 1
    FROM pg_type type_row
    WHERE type_row.typnamespace = 'public'::regnamespace
      AND type_row.typtype = 'e'
      AND type_row.typowner <> (SELECT oid FROM pg_roles WHERE rolname = target_owner_name)
  ) OR EXISTS (
    SELECT 1
    FROM pg_namespace namespace_row
    WHERE namespace_row.nspname IN ('bauth', 'fpl', 'wechat')
      AND namespace_row.nspowner <> (SELECT oid FROM pg_roles WHERE rolname = target_owner_name)
  ) OR EXISTS (
    SELECT 1
    FROM pg_class relation_row
    JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
    WHERE namespace_row.nspname IN ('bauth', 'fpl', 'wechat')
      AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')
      AND relation_row.relowner <> (SELECT oid FROM pg_roles WHERE rolname = target_owner_name)
  ) THEN
    RAISE EXCEPTION 'P5 B0 ownership normalization is incomplete';
  END IF;
END
$postcondition$;

COMMIT;

SELECT
  'p5_b0_ownership_normalized' AS status,
  current_database() AS database_name,
  current_setting('letletme.p5_target_owner', true) AS owner_name;
