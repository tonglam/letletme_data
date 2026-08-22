-- Keep historical FPL player identities while distinguishing the roster in
-- the latest canonical core publication. Player Stats completeness must use
-- this active roster, not every player ever observed in the season.
ALTER TABLE fpl.players
  ADD COLUMN is_active boolean NOT NULL DEFAULT true;

CREATE INDEX players_active_idx
  ON fpl.players USING btree (season_id, is_active, element_id);
