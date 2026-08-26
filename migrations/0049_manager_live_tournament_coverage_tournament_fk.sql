-- Fence manager-live coverage against deleted tournaments.  Older deployments
-- could have an orphan from a worker that was already in flight at deletion;
-- remove only those rows before adding the composite foreign key.

DELETE FROM fpl.manager_live_tournament_coverage coverage
WHERE NOT EXISTS (
  SELECT 1
  FROM competition.tournaments tournament
  WHERE tournament.season_id = coverage.season_id
    AND tournament.tournament_id = coverage.tournament_id
);

ALTER TABLE fpl.manager_live_tournament_coverage
  ADD CONSTRAINT manager_live_tournament_coverage_tournament_fk
  FOREIGN KEY (season_id, tournament_id)
  REFERENCES competition.tournaments(season_id, tournament_id)
  ON DELETE CASCADE;
