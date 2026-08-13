CREATE TABLE reporting.player_season_summary_rows (
  season_id smallint NOT NULL,
  element_id integer NOT NULL,
  element_type integer NOT NULL,
  gameweeks_available integer NOT NULL,
  gameweeks_started integer NOT NULL,
  minutes integer NOT NULL,
  goals_scored integer NOT NULL,
  assists integer NOT NULL,
  clean_sheets integer NOT NULL,
  goals_conceded integer NOT NULL,
  own_goals integer NOT NULL,
  penalties_saved integer NOT NULL,
  penalties_missed integer NOT NULL,
  yellow_cards integer NOT NULL,
  red_cards integer NOT NULL,
  saves integer NOT NULL,
  bonus integer NOT NULL,
  bps integer NOT NULL,
  total_points integer NOT NULL,
  defensive_contribution integer NOT NULL,
  expected_goals numeric NOT NULL,
  expected_assists numeric NOT NULL,
  expected_goal_involvements numeric NOT NULL,
  expected_goals_conceded numeric NOT NULL,
  dream_team_appearances integer NOT NULL,
  return_count integer NOT NULL,
  source_updated_at timestamptz NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_season_summary_rows_pkey PRIMARY KEY (season_id, element_id),
  CONSTRAINT player_season_summary_rows_player_fk
    FOREIGN KEY (season_id, element_id)
    REFERENCES fpl.players (season_id, element_id),
  CONSTRAINT player_season_summary_rows_counts_nonnegative CHECK (
    gameweeks_available >= 0
    AND gameweeks_started >= 0
    AND minutes >= 0
    AND goals_scored >= 0
    AND assists >= 0
    AND clean_sheets >= 0
    AND goals_conceded >= 0
    AND own_goals >= 0
    AND penalties_saved >= 0
    AND penalties_missed >= 0
    AND yellow_cards >= 0
    AND red_cards >= 0
    AND saves >= 0
    AND bonus >= 0
    AND defensive_contribution >= 0
    AND dream_team_appearances >= 0
    AND return_count >= 0
  )
);

CREATE INDEX player_season_summary_rows_cohort_idx
  ON reporting.player_season_summary_rows (season_id, element_type, element_id);

CREATE TABLE reporting.player_season_summary_refreshes (
  season_id smallint PRIMARY KEY,
  revision bigint NOT NULL,
  source_updated_at timestamptz NOT NULL,
  refreshed_at timestamptz NOT NULL,
  player_count integer NOT NULL,
  stats_row_count bigint NOT NULL,
  CONSTRAINT player_season_summary_refreshes_season_fk
    FOREIGN KEY (season_id) REFERENCES fpl.seasons (season_id),
  CONSTRAINT player_season_summary_refreshes_revision_positive CHECK (revision > 0),
  CONSTRAINT player_season_summary_refreshes_counts_nonnegative CHECK (
    player_count >= 0 AND stats_row_count >= 0
  )
);

CREATE OR REPLACE FUNCTION reporting.refresh_player_season_summaries(
  requested_season_id smallint
)
RETURNS TABLE (
  revision bigint,
  player_count integer,
  stats_row_count bigint,
  source_updated_at timestamptz,
  refreshed_at timestamptz
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, reporting, fpl
AS $$
DECLARE
  refresh_time timestamptz;
  source_time timestamptz;
  refreshed_players integer;
  source_rows bigint;
  next_revision bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM fpl.seasons WHERE season_id = requested_season_id
  ) THEN
    RAISE EXCEPTION 'Unknown FPL season id %', requested_season_id;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('reporting:player-season-summaries:' || requested_season_id::text, 0)
  );
  refresh_time := clock_timestamp();

  SELECT GREATEST(
    COALESCE(max(player.updated_at), '-infinity'::timestamptz),
    COALESCE((
      SELECT max(stats.updated_at)
      FROM fpl.player_gameweek_stats stats
      WHERE stats.season_id = requested_season_id
    ), '-infinity'::timestamptz)
  )
  INTO source_time
  FROM fpl.players player
  WHERE player.season_id = requested_season_id;

  IF source_time = '-infinity'::timestamptz THEN
    source_time := refresh_time;
  END IF;

  DELETE FROM reporting.player_season_summary_rows
  WHERE season_id = requested_season_id;

  INSERT INTO reporting.player_season_summary_rows (
    season_id,
    element_id,
    element_type,
    gameweeks_available,
    gameweeks_started,
    minutes,
    goals_scored,
    assists,
    clean_sheets,
    goals_conceded,
    own_goals,
    penalties_saved,
    penalties_missed,
    yellow_cards,
    red_cards,
    saves,
    bonus,
    bps,
    total_points,
    defensive_contribution,
    expected_goals,
    expected_assists,
    expected_goal_involvements,
    expected_goals_conceded,
    dream_team_appearances,
    return_count,
    source_updated_at,
    refreshed_at
  )
  SELECT
    player.season_id,
    player.element_id,
    player.element_type,
    count(stats.event_id)::integer,
    count(*) FILTER (WHERE stats.starts IS TRUE)::integer,
    COALESCE(sum(stats.minutes), 0)::integer,
    COALESCE(sum(stats.goals_scored), 0)::integer,
    COALESCE(sum(stats.assists), 0)::integer,
    COALESCE(sum(stats.clean_sheets), 0)::integer,
    COALESCE(sum(stats.goals_conceded), 0)::integer,
    COALESCE(sum(stats.own_goals), 0)::integer,
    COALESCE(sum(stats.penalties_saved), 0)::integer,
    COALESCE(sum(stats.penalties_missed), 0)::integer,
    COALESCE(sum(stats.yellow_cards), 0)::integer,
    COALESCE(sum(stats.red_cards), 0)::integer,
    COALESCE(sum(stats.saves), 0)::integer,
    COALESCE(sum(stats.bonus), 0)::integer,
    COALESCE(sum(stats.bps), 0)::integer,
    COALESCE(sum(stats.total_points), 0)::integer,
    COALESCE(sum(stats.defensive_contribution), 0)::integer,
    COALESCE(sum(stats.expected_goals), 0::numeric),
    COALESCE(sum(stats.expected_assists), 0::numeric),
    COALESCE(sum(stats.expected_goal_involvements), 0::numeric),
    COALESCE(sum(stats.expected_goals_conceded), 0::numeric),
    count(*) FILTER (WHERE stats.in_dream_team IS TRUE)::integer,
    count(*) FILTER (WHERE stats.total_points >= 5)::integer,
    GREATEST(player.updated_at, COALESCE(max(stats.updated_at), player.updated_at)),
    refresh_time
  FROM fpl.players player
  LEFT JOIN fpl.player_gameweek_stats stats
    ON stats.season_id = player.season_id
    AND stats.element_id = player.element_id
  WHERE player.season_id = requested_season_id
  GROUP BY player.season_id, player.element_id, player.element_type, player.updated_at;

  GET DIAGNOSTICS refreshed_players = ROW_COUNT;

  SELECT count(*)::bigint
  INTO source_rows
  FROM fpl.player_gameweek_stats
  WHERE season_id = requested_season_id;

  INSERT INTO reporting.player_season_summary_refreshes (
    season_id,
    revision,
    source_updated_at,
    refreshed_at,
    player_count,
    stats_row_count
  ) VALUES (
    requested_season_id,
    1,
    source_time,
    refresh_time,
    refreshed_players,
    source_rows
  )
  ON CONFLICT (season_id) DO UPDATE SET
    revision = reporting.player_season_summary_refreshes.revision + 1,
    source_updated_at = EXCLUDED.source_updated_at,
    refreshed_at = EXCLUDED.refreshed_at,
    player_count = EXCLUDED.player_count,
    stats_row_count = EXCLUDED.stats_row_count
  RETURNING reporting.player_season_summary_refreshes.revision
  INTO next_revision;

  RETURN QUERY SELECT
    next_revision,
    refreshed_players,
    source_rows,
    source_time,
    refresh_time;
END;
$$;

DO $$
DECLARE
  season_row record;
BEGIN
  FOR season_row IN SELECT season_id FROM fpl.seasons ORDER BY season_id LOOP
    PERFORM reporting.refresh_player_season_summaries(season_row.season_id);
  END LOOP;
END;
$$;

DROP VIEW reporting.player_season_summaries;

CREATE VIEW reporting.player_season_summaries
WITH (security_invoker='true') AS
SELECT
  season_id,
  element_id,
  element_type,
  gameweeks_available,
  gameweeks_started,
  minutes,
  goals_scored,
  assists,
  clean_sheets,
  goals_conceded,
  own_goals,
  penalties_saved,
  penalties_missed,
  yellow_cards,
  red_cards,
  saves,
  bonus,
  bps,
  total_points,
  defensive_contribution,
  expected_goals,
  expected_assists,
  expected_goal_involvements,
  expected_goals_conceded,
  dream_team_appearances,
  return_count,
  source_updated_at,
  refreshed_at
FROM reporting.player_season_summary_rows;

ALTER TABLE reporting.player_season_summary_rows OWNER TO letletme_data_owner;
ALTER TABLE reporting.player_season_summary_refreshes OWNER TO letletme_data_owner;
ALTER VIEW reporting.player_season_summaries OWNER TO letletme_data_owner;
ALTER FUNCTION reporting.refresh_player_season_summaries(smallint)
  OWNER TO letletme_data_owner;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON reporting.player_season_summary_rows TO letletme_data_writer;
GRANT SELECT, INSERT, UPDATE
  ON reporting.player_season_summary_refreshes TO letletme_data_writer;
REVOKE EXECUTE
  ON FUNCTION reporting.refresh_player_season_summaries(smallint) FROM PUBLIC;
GRANT EXECUTE
  ON FUNCTION reporting.refresh_player_season_summaries(smallint) TO letletme_data_writer;
GRANT SELECT ON reporting.player_season_summary_rows TO letletme_graphql_reader;
GRANT SELECT ON reporting.player_season_summary_refreshes TO letletme_graphql_reader;
GRANT SELECT ON reporting.player_season_summaries TO letletme_graphql_reader;
