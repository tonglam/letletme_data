-- Close the runtime constraints exposed while integrating the PostgreSQL-only
-- Understat pipeline into the v3 schema.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL ROLE letletme_data_owner;

LOCK TABLE bridge.entity_links, understat.player_team_seasons IN SHARE ROW EXCLUSIVE MODE;

DO $bridge_entity_pair_contract$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM bridge.entity_links
    GROUP BY entity_type, left_provider, left_entity_id, right_provider, right_entity_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'bridge.entity_links contains duplicate provider pairs';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'bridge.entity_links'::regclass
      AND conname = 'bridge_entity_links_pair_unique'
  ) THEN
    ALTER TABLE bridge.entity_links
      ADD CONSTRAINT bridge_entity_links_pair_unique
      UNIQUE NULLS NOT DISTINCT (
        entity_type,
        left_provider,
        left_entity_id,
        right_provider,
        right_entity_id
      );
  END IF;
END
$bridge_entity_pair_contract$;

ALTER TABLE understat.player_team_seasons
  DROP CONSTRAINT IF EXISTS understat_player_team_team_season_fk;

DROP INDEX IF EXISTS understat.understat_player_team_team_season_fk_idx;

CREATE INDEX IF NOT EXISTS understat_player_team_season_fk_idx
  ON understat.player_team_seasons (season_code);

DO $understat_player_team_lane_contract$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'understat.player_team_seasons'::regclass
      AND conname = 'understat_player_team_season_fk'
  ) THEN
    ALTER TABLE understat.player_team_seasons
      ADD CONSTRAINT understat_player_team_season_fk
      FOREIGN KEY (season_code) REFERENCES understat.seasons(season_code) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'understat.player_team_seasons'::regclass
      AND conname = 'understat_player_team_team_fk'
  ) THEN
    ALTER TABLE understat.player_team_seasons
      ADD CONSTRAINT understat_player_team_team_fk
      FOREIGN KEY (team_id) REFERENCES understat.teams(team_id) NOT VALID;
  END IF;
END
$understat_player_team_lane_contract$;

ALTER TABLE understat.player_team_seasons
  VALIDATE CONSTRAINT understat_player_team_season_fk;

ALTER TABLE understat.player_team_seasons
  VALIDATE CONSTRAINT understat_player_team_team_fk;

-- Sync control is unified in ops.sync_runs/ops.sync_items, whose constrained
-- text fields preserve historical provider values. These provider-local types
-- have no column dependencies and must not survive as a second sync contract.
DROP TYPE IF EXISTS understat.lane;
DROP TYPE IF EXISTS understat.sync_item_status;
DROP TYPE IF EXISTS understat.sync_mode;
DROP TYPE IF EXISTS understat.sync_run_status;
DROP TYPE IF EXISTS understat.sync_trigger;

RESET ROLE;
