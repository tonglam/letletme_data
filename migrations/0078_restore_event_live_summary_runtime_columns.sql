-- Restore the event/team columns required by the current live-summary writer.
-- Historical migration 0069 intentionally changed this table to a season-level
-- aggregate, but the current runtime still replaces event-scoped rows and the
-- production ledger already contains 0069. Keep 0069 immutable and restore
-- the active runtime contract in a tail migration.

ALTER TABLE public.event_live_summaries
  ADD COLUMN IF NOT EXISTS event_id integer,
  ADD COLUMN IF NOT EXISTS team_id integer;

-- Existing aggregate rows came from event_lives, so use their latest event and
-- the current player dimension to make the restored required columns valid.
UPDATE public.event_live_summaries AS summary
SET
  event_id = source.event_id,
  team_id = source.team_id
FROM (
  SELECT
    summary_row.id,
    MAX(live.event_id) AS event_id,
    player.team_id
  FROM public.event_live_summaries AS summary_row
  JOIN public.event_lives AS live
    ON live.element_id = summary_row.element_id
  JOIN public.players AS player
    ON player.id = summary_row.element_id
  GROUP BY summary_row.id, player.team_id
) AS source
WHERE summary.id = source.id
  AND (summary.event_id IS NULL OR summary.team_id IS NULL);

ALTER TABLE public.event_live_summaries
  ALTER COLUMN event_id SET NOT NULL,
  ALTER COLUMN team_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'event_live_summaries_event_id_events_id_fk'
  ) THEN
    ALTER TABLE public.event_live_summaries
      ADD CONSTRAINT event_live_summaries_event_id_events_id_fk
      FOREIGN KEY (event_id) REFERENCES public.events(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'event_live_summaries_team_id_teams_id_fk'
  ) THEN
    ALTER TABLE public.event_live_summaries
      ADD CONSTRAINT event_live_summaries_team_id_teams_id_fk
      FOREIGN KEY (team_id) REFERENCES public.teams(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_event_live_summary_event_id
  ON public.event_live_summaries (event_id);
