-- Bind the finalized score row to the exact 15 picks used to produce it.
-- The normalized picks table remains a write/read model for current team data,
-- but a result must carry its immutable score-bearing pick payload so final
-- consumers cannot combine a result with a later mutable picks revision.
ALTER TABLE competition.entry_event_results
  ADD COLUMN IF NOT EXISTS event_picks jsonb;

UPDATE competition.entry_event_results result
SET event_picks = COALESCE((
  SELECT jsonb_agg(
           jsonb_build_object(
             'element', pick.element_id,
             'position', pick.position,
             'multiplier', pick.multiplier,
             'is_captain', pick.is_captain,
             'is_vice_captain', pick.is_vice_captain
           ) ORDER BY pick.position
         )
  FROM competition.entry_event_picks pick
  WHERE pick.season_id = result.season_id
    AND pick.entry_id = result.entry_id
    AND pick.event_id = result.event_id
), '[]'::jsonb)
WHERE result.event_picks IS NULL;

ALTER TABLE competition.entry_event_results
  ALTER COLUMN event_picks SET DEFAULT '[]'::jsonb,
  ALTER COLUMN event_picks SET NOT NULL;

ALTER TABLE competition.entry_event_results
  DROP CONSTRAINT IF EXISTS entry_event_results_event_picks_array;

ALTER TABLE competition.entry_event_results
  ADD CONSTRAINT entry_event_results_event_picks_array
  CHECK (jsonb_typeof(event_picks) = 'array'::text);

COMMENT ON COLUMN competition.entry_event_results.event_picks IS
  'Immutable normalized FPL picks payload used for this result score; final consumers must not join a later picks revision';
