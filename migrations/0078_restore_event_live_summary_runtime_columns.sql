-- Restore the event/team columns required by the current live-summary writer.
-- Historical migration 0069 intentionally changed this table to a season-level
-- aggregate, but the current runtime still replaces event-scoped rows and the
-- production ledger already contains 0069. Keep 0069 immutable and restore
-- the active runtime contract in a tail migration.

DO $$
DECLARE
  missing_runtime_columns boolean;
BEGIN
  SELECT count(*) < 2
  INTO missing_runtime_columns
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'event_live_summaries'
    AND column_name IN ('event_id', 'team_id');

  ALTER TABLE public.event_live_summaries
    ADD COLUMN IF NOT EXISTS event_id integer,
    ADD COLUMN IF NOT EXISTS team_id integer;

  IF missing_runtime_columns THEN
    -- Migration 0069 left season/player totals in this table. They cannot be
    -- truthfully assigned to one event, so clear the derived checkpoint and
    -- let the next event-live sync repopulate the event-grain rows.
    TRUNCATE TABLE public.event_live_summaries RESTART IDENTITY;
  END IF;
END $$;

ALTER TABLE public.event_live_summaries
  ALTER COLUMN event_id SET NOT NULL,
  ALTER COLUMN team_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.event_live_summaries'::regclass
      AND constraint_row.confrelid = 'public.events'::regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.conkey = ARRAY[
        (SELECT attribute.attnum
         FROM pg_attribute AS attribute
         WHERE attribute.attrelid = 'public.event_live_summaries'::regclass
           AND attribute.attname = 'event_id')
      ]::smallint[]
      AND constraint_row.confkey = ARRAY[
        (SELECT attribute.attnum
         FROM pg_attribute AS attribute
         WHERE attribute.attrelid = 'public.events'::regclass
           AND attribute.attname = 'id')
      ]::smallint[]
  ) THEN
    ALTER TABLE public.event_live_summaries
      ADD CONSTRAINT event_live_summaries_event_id_events_id_fk
      FOREIGN KEY (event_id) REFERENCES public.events(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.event_live_summaries'::regclass
      AND constraint_row.confrelid = 'public.teams'::regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.conkey = ARRAY[
        (SELECT attribute.attnum
         FROM pg_attribute AS attribute
         WHERE attribute.attrelid = 'public.event_live_summaries'::regclass
           AND attribute.attname = 'team_id')
      ]::smallint[]
      AND constraint_row.confkey = ARRAY[
        (SELECT attribute.attnum
         FROM pg_attribute AS attribute
         WHERE attribute.attrelid = 'public.teams'::regclass
           AND attribute.attname = 'id')
      ]::smallint[]
  ) THEN
    ALTER TABLE public.event_live_summaries
      ADD CONSTRAINT event_live_summaries_team_id_teams_id_fk
      FOREIGN KEY (team_id) REFERENCES public.teams(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_event_live_summary_event_id
  ON public.event_live_summaries (event_id);
