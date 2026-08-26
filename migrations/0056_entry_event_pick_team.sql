-- Preserve the team identity that was observed when an event pick was captured.
-- Scoring must not join a historical pick to the mutable current fpl.players row.
ALTER TABLE competition.entry_event_picks
  ADD COLUMN event_team_id integer;

ALTER TABLE competition.entry_event_picks
  ADD CONSTRAINT entry_event_picks_event_team_fk
  FOREIGN KEY (season_id, event_team_id)
  REFERENCES fpl.teams (season_id, team_id);

CREATE INDEX entry_event_picks_event_team_idx
  ON competition.entry_event_picks (season_id, event_id, event_team_id);

COMMENT ON COLUMN competition.entry_event_picks.event_team_id IS
  'Team identity captured with the event pick; scoring never derives it from mutable fpl.players.team_id.';

-- Recover an event-scoped identity where fixture evidence already exists. Rows
-- without such evidence remain NULL and fail closed until the next pick capture
-- records the deadline-time team rather than guessing from current player data.
WITH event_team AS (
  SELECT
    pick.season_id,
    pick.entry_id,
    pick.event_id,
    pick.position,
    min(stats.team_id) AS team_id
  FROM competition.entry_event_picks pick
  JOIN fpl.player_fixture_stats stats
    ON stats.season_id = pick.season_id
   AND stats.event_id = pick.event_id
   AND stats.element_id = pick.element_id
  GROUP BY pick.season_id, pick.entry_id, pick.event_id, pick.position
  HAVING count(DISTINCT stats.team_id) = 1
)
UPDATE competition.entry_event_picks pick
SET event_team_id = event_team.team_id
FROM event_team
WHERE pick.season_id = event_team.season_id
  AND pick.entry_id = event_team.entry_id
  AND pick.event_id = event_team.event_id
  AND pick.position = event_team.position
  AND pick.event_team_id IS NULL;
