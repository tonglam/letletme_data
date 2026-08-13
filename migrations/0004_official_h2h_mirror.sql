-- Reuse the existing tournament battle/knockout model for authoritative FPL H2H mirrors.

ALTER TABLE competition.tournaments
  ADD COLUMN official_schedule_hash text,
  ADD COLUMN official_schedule_synced_at timestamptz,
  ADD COLUMN official_schedule_locked_at timestamptz;

ALTER TABLE competition.tournament_battle_group_results
  ALTER COLUMN home_entry_id DROP NOT NULL,
  ALTER COLUMN away_entry_id DROP NOT NULL,
  ADD COLUMN official_match_id integer,
  ADD COLUMN source_order integer,
  ADD COLUMN home_is_average boolean NOT NULL DEFAULT false,
  ADD COLUMN away_is_average boolean NOT NULL DEFAULT false,
  ADD COLUMN is_bye boolean NOT NULL DEFAULT false,
  ADD COLUMN source_checked_at timestamptz;

ALTER TABLE competition.tournament_battle_group_results
  DROP CONSTRAINT tournament_battle_group_results_distinct_entries,
  DROP CONSTRAINT tournament_battle_group_results_ids_positive,
  ADD CONSTRAINT tournament_battle_group_results_distinct_entries
    CHECK (
      home_entry_id IS NULL
      OR away_entry_id IS NULL
      OR home_entry_id <> away_entry_id
    ),
  ADD CONSTRAINT tournament_battle_group_results_ids_positive
    CHECK (
      source_result_id > 0
      AND tournament_id > 0
      AND group_id > 0
      AND event_id > 0
      AND (official_match_id IS NULL OR official_match_id > 0)
      AND (source_order IS NULL OR source_order >= 0)
    ),
  ADD CONSTRAINT tournament_battle_group_results_side_contract
    CHECK (
      ((home_is_average AND home_entry_id IS NULL)
        OR (NOT home_is_average AND home_entry_id > 0))
      AND ((away_is_average AND away_entry_id IS NULL)
        OR (NOT away_is_average AND away_entry_id > 0))
      AND NOT (home_is_average AND away_is_average)
      AND (NOT (home_is_average OR away_is_average) OR official_match_id IS NOT NULL)
      AND (NOT is_bye OR official_match_id IS NOT NULL)
    ),
  ADD CONSTRAINT tournament_battle_group_results_official_order_contract
    CHECK (
      (official_match_id IS NULL AND source_order IS NULL)
      OR (official_match_id IS NOT NULL AND source_order IS NOT NULL)
    );

CREATE UNIQUE INDEX tournament_battle_group_results_official_match_unique
  ON competition.tournament_battle_group_results (tournament_id, official_match_id)
  WHERE official_match_id IS NOT NULL;

CREATE INDEX tournament_battle_group_results_official_display_idx
  ON competition.tournament_battle_group_results
    (tournament_id, event_id, source_order, official_match_id)
  WHERE official_match_id IS NOT NULL;

ALTER TABLE competition.tournament_knockout_results
  ADD COLUMN official_match_id integer,
  ADD COLUMN source_order integer,
  ADD COLUMN knockout_name text,
  ADD COLUMN tiebreak text,
  ADD COLUMN source_checked_at timestamptz,
  ADD CONSTRAINT tournament_knockout_results_official_fields_valid
    CHECK (
      (official_match_id IS NULL OR official_match_id > 0)
      AND (source_order IS NULL OR source_order >= 0)
      AND (
        (official_match_id IS NULL AND source_order IS NULL)
        OR (official_match_id IS NOT NULL AND source_order IS NOT NULL)
      )
    );

CREATE UNIQUE INDEX tournament_knockout_results_official_match_unique
  ON competition.tournament_knockout_results (tournament_id, official_match_id)
  WHERE official_match_id IS NOT NULL;

CREATE INDEX tournament_knockout_results_official_display_idx
  ON competition.tournament_knockout_results
    (tournament_id, event_id, source_order, official_match_id)
  WHERE official_match_id IS NOT NULL;

-- Average Team is a match side, not a tournament entry. Keep the canonical
-- participant-result view to one row per real entry while retaining the real
-- opponent's official result from the same battle row.
CREATE OR REPLACE VIEW reporting.tournament_event_results
WITH (security_invoker='true') AS
SELECT
  points.tournament_id,
  points.season_id,
  points.event_id,
  'points_group'::text AS result_type,
  points.source_result_id,
  points.group_id,
  NULL::integer AS match_id,
  NULL::integer AS play_against_id,
  points.entry_id,
  NULL::integer AS opponent_entry_id,
  points.event_points,
  points.event_cost,
  points.event_net_points,
  points.event_rank,
  NULL::integer AS match_points,
  NULL::integer AS goals_for,
  NULL::integer AS goals_against,
  NULL::boolean AS is_winner,
  points.created_at,
  points.updated_at
FROM competition.tournament_points_group_results points
UNION ALL
SELECT
  battle.tournament_id,
  battle.season_id,
  battle.event_id,
  'battle_group'::text AS result_type,
  battle.source_result_id,
  battle.group_id,
  NULL::integer AS match_id,
  NULL::integer AS play_against_id,
  side.entry_id,
  side.opponent_entry_id,
  NULL::integer AS event_points,
  NULL::integer AS event_cost,
  side.net_points AS event_net_points,
  side.event_rank,
  side.match_points,
  NULL::integer AS goals_for,
  NULL::integer AS goals_against,
  CASE
    WHEN side.match_points IS NULL OR side.opponent_match_points IS NULL THEN NULL::boolean
    ELSE side.match_points > side.opponent_match_points
  END AS is_winner,
  battle.created_at,
  battle.updated_at
FROM competition.tournament_battle_group_results battle
CROSS JOIN LATERAL (
  VALUES
    (battle.home_entry_id, battle.away_entry_id, battle.home_net_points,
      battle.home_rank, battle.home_match_points, battle.away_match_points),
    (battle.away_entry_id, battle.home_entry_id, battle.away_net_points,
      battle.away_rank, battle.away_match_points, battle.home_match_points)
) side(entry_id, opponent_entry_id, net_points, event_rank, match_points, opponent_match_points)
WHERE side.entry_id IS NOT NULL
UNION ALL
SELECT
  knockout.tournament_id,
  knockout.season_id,
  knockout.event_id,
  'knockout'::text AS result_type,
  knockout.source_result_id,
  NULL::integer AS group_id,
  knockout.match_id,
  knockout.play_against_id,
  side.entry_id,
  side.opponent_entry_id,
  NULL::integer AS event_points,
  NULL::integer AS event_cost,
  side.net_points AS event_net_points,
  NULL::integer AS event_rank,
  NULL::integer AS match_points,
  side.goals_for,
  side.goals_against,
  CASE
    WHEN knockout.match_winner IS NULL OR side.entry_id IS NULL THEN NULL::boolean
    ELSE knockout.match_winner = side.entry_id
  END AS is_winner,
  knockout.created_at,
  knockout.updated_at
FROM competition.tournament_knockout_results knockout
CROSS JOIN LATERAL (
  VALUES
    (knockout.home_entry_id, knockout.away_entry_id, knockout.home_net_points,
      knockout.home_goals_scored, knockout.home_goals_conceded),
    (knockout.away_entry_id, knockout.home_entry_id, knockout.away_net_points,
      knockout.away_goals_scored, knockout.away_goals_conceded)
) side(entry_id, opponent_entry_id, net_points, goals_for, goals_against)
WHERE side.entry_id IS NOT NULL;
