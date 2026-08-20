CREATE SCHEMA IF NOT EXISTS extensions;

DO $$
DECLARE
  installed_schema text;
BEGIN
  SELECT namespace.nspname
    INTO installed_schema
  FROM pg_extension extension_row
  JOIN pg_namespace namespace ON namespace.oid = extension_row.extnamespace
  WHERE extension_row.extname = 'pg_trgm';

  IF installed_schema IS NULL THEN
    EXECUTE 'CREATE EXTENSION pg_trgm WITH SCHEMA extensions';
  ELSIF installed_schema <> 'extensions' THEN
    EXECUTE 'ALTER EXTENSION pg_trgm SET SCHEMA extensions';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS entries_entry_name_trgm_idx
  ON competition.entries USING gin (entry_name extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS entries_player_name_trgm_idx
  ON competition.entries USING gin (player_name extensions.gin_trgm_ops);
