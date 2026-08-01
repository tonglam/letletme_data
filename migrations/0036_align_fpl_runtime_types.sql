-- Align legacy production columns with the current Drizzle/domain contract.
-- Existing timestamp-without-time-zone values were written in a UTC database
-- session, so interpret their wall-clock values as UTC during conversion.

DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT *
    FROM (VALUES
      ('event_fixtures', 'updated_at'),
      ('event_live_summaries', 'created_at'),
      ('event_live_summaries', 'updated_at'),
      ('events', 'created_at'),
      ('events', 'updated_at'),
      ('players', 'updated_at')
    ) AS columns(table_name, column_name)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = target.table_name
        AND column_name = target.column_name
        AND data_type = 'timestamp without time zone'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN %I TYPE timestamptz USING %I AT TIME ZONE ''UTC''',
        target.table_name,
        target.column_name,
        target.column_name
      );
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'teams'
      AND column_name = 'unavailable'
      AND data_type <> 'boolean'
  ) THEN
    ALTER TABLE public.teams
      ALTER COLUMN unavailable DROP DEFAULT,
      ALTER COLUMN unavailable TYPE boolean USING unavailable <> 0,
      ALTER COLUMN unavailable SET DEFAULT false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'events'
      AND column_name = 'average_entry_score'
      AND data_type <> 'integer'
  ) THEN
    ALTER TABLE public.events
      ALTER COLUMN average_entry_score TYPE integer
      USING round(average_entry_score)::integer;
  END IF;
END $$;

UPDATE public.events SET created_at = now() WHERE created_at IS NULL;
ALTER TABLE public.events ALTER COLUMN created_at SET NOT NULL;
