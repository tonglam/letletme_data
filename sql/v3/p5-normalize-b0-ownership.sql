\set ON_ERROR_STOP on
\if :{?target_owner}
\else
\echo target_owner is required
\quit 3
\endif

-- pg_restore --no-owner assigns B0 objects to the local restore login. P5
-- normalizes only an isolated p5_* database so 0090 sees the same one-owner
-- contract required at production preflight.

SET statement_timeout = '5min';
SET lock_timeout = '5s';
SELECT set_config('letletme.p5_target_owner', :'target_owner', false);

DO $safety_contract$
DECLARE
  public_enum_count bigint;
  public_function_count bigint;
  public_relation_count bigint;
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
END
$safety_contract$;

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
  ) THEN
    RAISE EXCEPTION 'P5 B0 ownership normalization is incomplete';
  END IF;
END
$postcondition$;

SELECT
  'p5_b0_ownership_normalized' AS status,
  current_database() AS database_name,
  current_setting('letletme.p5_target_owner', true) AS owner_name;
