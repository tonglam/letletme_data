-- Reduce projection write amplification without changing the read contracts.
-- The previous functions remain available as private full-rebuild fallbacks;
-- the public writer entry points short-circuit unchanged source watermarks and
-- reconcile player summaries with a set-based diff.

ALTER TABLE competition.tournament_points_group_results
  ADD COLUMN source_updated_at timestamptz;

-- Before this migration local battle/knockout rows used the application wall
-- clock for source_checked_at.  That timestamp is not comparable with the
-- rich FPL source watermark used by the new stale-input guard.  Rebase local
-- rows onto the newest persisted entry result watermark; rows without rich
-- evidence stay NULL and are accepted once on the next source-aware replay.
WITH source_watermarks AS (
  SELECT
    result.tournament_id,
    result.source_result_id,
    max(entry.rich_synced_at) AS source_checked_at
  FROM competition.tournament_battle_group_results result
  LEFT JOIN competition.entry_event_results entry
    ON entry.season_id = result.season_id
   AND entry.event_id = result.event_id
   AND entry.entry_id IN (result.home_entry_id, result.away_entry_id)
  WHERE result.official_match_id IS NULL
  GROUP BY result.tournament_id, result.source_result_id
)
UPDATE competition.tournament_battle_group_results result
SET source_checked_at = source.source_checked_at
FROM source_watermarks source
WHERE result.tournament_id = source.tournament_id
  AND result.source_result_id = source.source_result_id
  AND result.source_checked_at IS DISTINCT FROM source.source_checked_at;

WITH source_watermarks AS (
  SELECT
    result.tournament_id,
    result.source_result_id,
    max(entry.rich_synced_at) AS source_checked_at
  FROM competition.tournament_knockout_results result
  LEFT JOIN competition.entry_event_results entry
    ON entry.season_id = result.season_id
   AND entry.event_id = result.event_id
   AND entry.entry_id IN (result.home_entry_id, result.away_entry_id)
  WHERE result.official_match_id IS NULL
  GROUP BY result.tournament_id, result.source_result_id
)
UPDATE competition.tournament_knockout_results result
SET source_checked_at = source.source_checked_at
FROM source_watermarks source
WHERE result.tournament_id = source.tournament_id
  AND result.source_result_id = source.source_result_id
  AND result.source_checked_at IS DISTINCT FROM source.source_checked_at;

ALTER FUNCTION reporting.refresh_player_season_summaries(smallint)
  RENAME TO refresh_player_season_summaries_full_rebuild;

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
  source_rows bigint;
  source_players integer;
  current_rows integer;
  existing reporting.player_season_summary_refreshes%ROWTYPE;
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

  SELECT count(*)::integer
  INTO source_players
  FROM fpl.players
  WHERE season_id = requested_season_id;

  SELECT count(*)::bigint
  INTO source_rows
  FROM fpl.player_gameweek_stats
  WHERE season_id = requested_season_id;

  SELECT *
  INTO existing
  FROM reporting.player_season_summary_refreshes
  WHERE season_id = requested_season_id;

  SELECT count(*)::integer
  INTO current_rows
  FROM reporting.player_season_summary_rows
  WHERE season_id = requested_season_id;

  -- Source timestamps are the freshness proof.  A zero-player season has no
  -- source clock to advance, so its existing metadata is also a valid no-op.
  IF existing.revision IS NOT NULL
    AND existing.player_count = source_players
    AND existing.stats_row_count = source_rows
    AND current_rows = source_players
    AND (
      source_players = 0
      OR existing.source_updated_at >= source_time
    )
    AND NOT EXISTS (
      SELECT 1
      FROM fpl.players player
      WHERE player.season_id = requested_season_id
        AND NOT EXISTS (
          SELECT 1
          FROM reporting.player_season_summary_rows summary
          WHERE summary.season_id = player.season_id
            AND summary.element_id = player.element_id
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM reporting.player_season_summary_rows summary
      WHERE summary.season_id = requested_season_id
        AND NOT EXISTS (
          SELECT 1
          FROM fpl.players player
          WHERE player.season_id = summary.season_id
            AND player.element_id = summary.element_id
        )
    )
  THEN
    RETURN QUERY SELECT
      existing.revision,
      existing.player_count,
      existing.stats_row_count,
      existing.source_updated_at,
      existing.refreshed_at;
    RETURN;
  END IF;

  DROP TABLE IF EXISTS pg_temp.player_season_summary_candidates;
  CREATE TEMP TABLE pg_temp.player_season_summary_candidates
    (LIKE reporting.player_season_summary_rows INCLUDING DEFAULTS)
    ON COMMIT DROP;

  INSERT INTO pg_temp.player_season_summary_candidates (
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

  INSERT INTO reporting.player_season_summary_rows AS existing_row (
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
    candidate.season_id,
    candidate.element_id,
    candidate.element_type,
    candidate.gameweeks_available,
    candidate.gameweeks_started,
    candidate.minutes,
    candidate.goals_scored,
    candidate.assists,
    candidate.clean_sheets,
    candidate.goals_conceded,
    candidate.own_goals,
    candidate.penalties_saved,
    candidate.penalties_missed,
    candidate.yellow_cards,
    candidate.red_cards,
    candidate.saves,
    candidate.bonus,
    candidate.bps,
    candidate.total_points,
    candidate.defensive_contribution,
    candidate.expected_goals,
    candidate.expected_assists,
    candidate.expected_goal_involvements,
    candidate.expected_goals_conceded,
    candidate.dream_team_appearances,
    candidate.return_count,
    candidate.source_updated_at,
    candidate.refreshed_at
  FROM pg_temp.player_season_summary_candidates candidate
  ON CONFLICT (season_id, element_id) DO UPDATE SET
    element_type = excluded.element_type,
    gameweeks_available = excluded.gameweeks_available,
    gameweeks_started = excluded.gameweeks_started,
    minutes = excluded.minutes,
    goals_scored = excluded.goals_scored,
    assists = excluded.assists,
    clean_sheets = excluded.clean_sheets,
    goals_conceded = excluded.goals_conceded,
    own_goals = excluded.own_goals,
    penalties_saved = excluded.penalties_saved,
    penalties_missed = excluded.penalties_missed,
    yellow_cards = excluded.yellow_cards,
    red_cards = excluded.red_cards,
    saves = excluded.saves,
    bonus = excluded.bonus,
    bps = excluded.bps,
    total_points = excluded.total_points,
    defensive_contribution = excluded.defensive_contribution,
    expected_goals = excluded.expected_goals,
    expected_assists = excluded.expected_assists,
    expected_goal_involvements = excluded.expected_goal_involvements,
    expected_goals_conceded = excluded.expected_goals_conceded,
    dream_team_appearances = excluded.dream_team_appearances,
    return_count = excluded.return_count,
    source_updated_at = excluded.source_updated_at,
    refreshed_at = excluded.refreshed_at
  WHERE ROW(
    existing_row.element_type,
    existing_row.gameweeks_available,
    existing_row.gameweeks_started,
    existing_row.minutes,
    existing_row.goals_scored,
    existing_row.assists,
    existing_row.clean_sheets,
    existing_row.goals_conceded,
    existing_row.own_goals,
    existing_row.penalties_saved,
    existing_row.penalties_missed,
    existing_row.yellow_cards,
    existing_row.red_cards,
    existing_row.saves,
    existing_row.bonus,
    existing_row.bps,
    existing_row.total_points,
    existing_row.defensive_contribution,
    existing_row.expected_goals,
    existing_row.expected_assists,
    existing_row.expected_goal_involvements,
    existing_row.expected_goals_conceded,
    existing_row.dream_team_appearances,
    existing_row.return_count,
    existing_row.source_updated_at
  ) IS DISTINCT FROM ROW(
    excluded.element_type,
    excluded.gameweeks_available,
    excluded.gameweeks_started,
    excluded.minutes,
    excluded.goals_scored,
    excluded.assists,
    excluded.clean_sheets,
    excluded.goals_conceded,
    excluded.own_goals,
    excluded.penalties_saved,
    excluded.penalties_missed,
    excluded.yellow_cards,
    excluded.red_cards,
    excluded.saves,
    excluded.bonus,
    excluded.bps,
    excluded.total_points,
    excluded.defensive_contribution,
    excluded.expected_goals,
    excluded.expected_assists,
    excluded.expected_goal_involvements,
    excluded.expected_goals_conceded,
    excluded.dream_team_appearances,
    excluded.return_count,
    excluded.source_updated_at
  );

  DELETE FROM reporting.player_season_summary_rows existing_row
  WHERE existing_row.season_id = requested_season_id
    AND NOT EXISTS (
      SELECT 1
      FROM pg_temp.player_season_summary_candidates candidate
      WHERE candidate.season_id = existing_row.season_id
        AND candidate.element_id = existing_row.element_id
    );

  SELECT count(*)::integer
  INTO source_players
  FROM pg_temp.player_season_summary_candidates;

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
    source_players,
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
    source_players,
    source_rows,
    source_time,
    refresh_time;
END;
$$;

ALTER FUNCTION reporting.refresh_player_season_summaries_full_rebuild(smallint)
  OWNER TO letletme_data_owner;
ALTER FUNCTION reporting.refresh_player_season_summaries(smallint)
  OWNER TO letletme_data_owner;
REVOKE EXECUTE ON FUNCTION reporting.refresh_player_season_summaries_full_rebuild(smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reporting.refresh_player_season_summaries_full_rebuild(smallint) TO letletme_data_writer;
REVOKE EXECUTE ON FUNCTION reporting.refresh_player_season_summaries(smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reporting.refresh_player_season_summaries(smallint) TO letletme_data_writer;

ALTER FUNCTION reporting.refresh_player_state_season(smallint)
  RENAME TO refresh_player_state_season_full_rebuild;

CREATE OR REPLACE FUNCTION reporting.refresh_player_state_season(
  requested_season_id smallint
)
RETURNS TABLE (
  revision bigint,
  player_count integer,
  understat_player_count integer,
  source_updated_at timestamptz,
  refreshed_at timestamptz
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, reporting, fpl, understat, bridge
AS $$
DECLARE
  refresh_time timestamptz;
  requested_code text;
  fpl_source_time timestamptz;
  understat_source_time timestamptz;
  bridge_source_time timestamptz;
  source_time timestamptz;
  refreshed_players integer;
  refreshed_understat_players integer;
  source_players integer;
  current_rows integer;
  current_understat_players integer;
  existing reporting.player_state_season_refreshes%ROWTYPE;
  next_revision bigint;
BEGIN
  SELECT season.season_code
  INTO requested_code
  FROM fpl.seasons season
  WHERE season.season_id = requested_season_id;

  IF requested_code IS NULL THEN
    RAISE EXCEPTION 'Unknown FPL season id %', requested_season_id;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('reporting:player-state-season:' || requested_season_id::text, 0)
  );
  refresh_time := clock_timestamp();

  SELECT GREATEST(
    COALESCE((SELECT max(player.updated_at) FROM fpl.players player WHERE player.season_id = requested_season_id), '-infinity'::timestamptz),
    COALESCE((SELECT max(summary.source_updated_at) FROM reporting.player_season_summary_rows summary WHERE summary.season_id = requested_season_id), '-infinity'::timestamptz)
  ) INTO fpl_source_time;

  SELECT GREATEST(
    COALESCE((SELECT max(metrics.updated_at) FROM understat.player_seasons metrics WHERE metrics.season_code = requested_code), '-infinity'::timestamptz),
    COALESCE((SELECT max(provider_season.updated_at) FROM understat.seasons provider_season WHERE provider_season.season_code = requested_code), '-infinity'::timestamptz)
  ) INTO understat_source_time;

  SELECT COALESCE(max(link.updated_at), '-infinity'::timestamptz)
  INTO bridge_source_time
  FROM bridge.entity_links link
  WHERE link.entity_type = 'player'
    AND link.left_provider = 'understat'
    AND link.right_provider = 'fpl';

  source_time := GREATEST(fpl_source_time, understat_source_time, bridge_source_time);

  IF (SELECT count(*) FROM fpl.players player WHERE player.season_id = requested_season_id)
       <> (SELECT count(*) FROM reporting.player_season_summary_rows summary WHERE summary.season_id = requested_season_id)
  THEN
    RAISE EXCEPTION 'Cannot publish Player State season % with incomplete FPL summary rows', requested_code;
  END IF;

  SELECT count(*)::integer
  INTO source_players
  FROM fpl.players
  WHERE season_id = requested_season_id;

  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE understat_player_id IS NOT NULL)::integer
  INTO current_rows, current_understat_players
  FROM reporting.player_state_season_rows
  WHERE season_id = requested_season_id;

  SELECT *
  INTO existing
  FROM reporting.player_state_season_refreshes
  WHERE season_id = requested_season_id;

  IF existing.revision IS NOT NULL
    AND current_rows = source_players
    AND existing.player_count = source_players
    AND existing.understat_player_count = current_understat_players
    AND existing.fpl_source_updated_at >= fpl_source_time
    AND existing.understat_source_updated_at >= understat_source_time
    AND existing.bridge_source_updated_at >= bridge_source_time
    AND NOT EXISTS (
      SELECT 1
      FROM fpl.players player
      WHERE player.season_id = requested_season_id
        AND NOT EXISTS (
          SELECT 1
          FROM reporting.player_state_season_rows state_row
          WHERE state_row.season_id = player.season_id
            AND state_row.element_id = player.element_id
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM reporting.player_state_season_rows state_row
      WHERE state_row.season_id = requested_season_id
        AND NOT EXISTS (
          SELECT 1
          FROM fpl.players player
          WHERE player.season_id = state_row.season_id
            AND player.element_id = state_row.element_id
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM reporting.player_state_season_rows state_row
      JOIN fpl.seasons season
        ON season.season_id = state_row.season_id
      WHERE state_row.season_id = requested_season_id
        AND (
          state_row.season_code IS DISTINCT FROM season.season_code
          OR state_row.lifecycle_state IS DISTINCT FROM season.lifecycle_state
        )
    )
  THEN
    SELECT metadata.revision
    INTO next_revision
    FROM reporting.player_state_dataset_metadata AS metadata
    WHERE metadata.dataset_key = 'player_state';
    IF next_revision IS NOT NULL THEN
      RETURN QUERY SELECT
        next_revision,
        existing.player_count,
        current_understat_players,
        existing.source_updated_at,
        existing.refreshed_at;
      RETURN;
    END IF;
  END IF;

  -- Empty source sets use the refresh timestamp as their durable marker, as
  -- the previous implementation did. The no-op branch above compares the
  -- unbounded source marker so a zero-player season does not rebuild forever.
  IF fpl_source_time = '-infinity'::timestamptz THEN
    fpl_source_time := refresh_time;
  END IF;
  IF understat_source_time = '-infinity'::timestamptz THEN
    understat_source_time := refresh_time;
  END IF;
  IF bridge_source_time = '-infinity'::timestamptz THEN
    bridge_source_time := refresh_time;
  END IF;
  source_time := GREATEST(fpl_source_time, understat_source_time, bridge_source_time);

  DROP TABLE IF EXISTS pg_temp.player_state_season_candidates;
  CREATE TEMP TABLE pg_temp.player_state_season_candidates
    (LIKE reporting.player_state_season_rows INCLUDING DEFAULTS)
    ON COMMIT DROP;

  WITH fpl_base AS MATERIALIZED (
    SELECT
      player.season_id,
      season.season_code,
      season.lifecycle_state,
      player.code AS player_code,
      player.element_id,
      player.element_type,
      COALESCE(summary.total_points, 0)::integer AS fpl_total_points,
      COALESCE(summary.gameweeks_started, 0)::integer AS fpl_starts,
      COALESCE(summary.clean_sheets, 0)::integer AS fpl_clean_sheets,
      COALESCE(summary.saves, 0)::integer AS fpl_saves,
      COALESCE(summary.minutes, 0)::integer AS fpl_minutes,
      COALESCE(summary.gameweeks_available, 0)::integer AS fpl_gameweeks,
      CASE WHEN COALESCE(summary.minutes, 0) > 0
        THEN (COALESCE(summary.total_points, 0)::numeric * 90) / summary.minutes
      END AS fpl_points_per_90,
      CASE WHEN COALESCE(summary.gameweeks_available, 0) > 0
        THEN (COALESCE(summary.return_count, 0)::numeric / summary.gameweeks_available) * 100
      END AS fpl_return_rate,
      CASE WHEN COALESCE(summary.minutes, 0) > 0
        THEN (COALESCE(summary.bonus, 0)::numeric * 90) / summary.minutes
      END AS fpl_bonus_per_90,
      GREATEST(player.updated_at, COALESCE(summary.source_updated_at, player.updated_at)) AS fpl_source_updated_at,
      md5(concat_ws('|', player.updated_at::text, summary.source_updated_at::text,
        COALESCE(summary.minutes, 0)::text, COALESCE(summary.total_points, 0)::text,
        COALESCE(summary.bonus, 0)::text, COALESCE(summary.return_count, 0)::text,
        COALESCE(summary.gameweeks_started, 0)::text, COALESCE(summary.clean_sheets, 0)::text,
        COALESCE(summary.saves, 0)::text)) AS fpl_source_hash,
      season.season_code >= '2223' AS expected_metrics_available
    FROM fpl.players player
    JOIN fpl.seasons season ON season.season_id = player.season_id
    LEFT JOIN reporting.player_season_summary_rows summary
      ON summary.season_id = player.season_id
     AND summary.element_id = player.element_id
    WHERE player.season_id = requested_season_id
  ),
  fpl_scored AS MATERIALIZED (
    SELECT
      subject.*,
      COALESCE(peer_stats.peer_count, 0)::integer AS fpl_peer_count,
      peer_stats.fpl_position_percentile
    FROM fpl_base subject
    LEFT JOIN LATERAL (
      SELECT
        count(*)::integer AS peer_count,
        round((
          COALESCE(CASE WHEN subject.fpl_points_per_90 IS NOT NULL
            AND count(*) FILTER (WHERE peer.fpl_points_per_90 IS NOT NULL) > 0
            THEN (
              count(*) FILTER (WHERE peer.fpl_points_per_90 < subject.fpl_points_per_90)
              + count(*) FILTER (WHERE peer.fpl_points_per_90 = subject.fpl_points_per_90) * 0.5
            )::numeric / count(*) FILTER (WHERE peer.fpl_points_per_90 IS NOT NULL) * 100
          END, 0)
          + COALESCE(CASE WHEN subject.fpl_return_rate IS NOT NULL
            AND count(*) FILTER (WHERE peer.fpl_return_rate IS NOT NULL) > 0
            THEN (
              count(*) FILTER (WHERE peer.fpl_return_rate < subject.fpl_return_rate)
              + count(*) FILTER (WHERE peer.fpl_return_rate = subject.fpl_return_rate) * 0.5
            )::numeric / count(*) FILTER (WHERE peer.fpl_return_rate IS NOT NULL) * 100
          END, 0)
          + COALESCE(CASE WHEN subject.fpl_bonus_per_90 IS NOT NULL
            AND count(*) FILTER (WHERE peer.fpl_bonus_per_90 IS NOT NULL) > 0
            THEN (
              count(*) FILTER (WHERE peer.fpl_bonus_per_90 < subject.fpl_bonus_per_90)
              + count(*) FILTER (WHERE peer.fpl_bonus_per_90 = subject.fpl_bonus_per_90) * 0.5
            )::numeric / count(*) FILTER (WHERE peer.fpl_bonus_per_90 IS NOT NULL) * 100
          END, 0)
        ) / NULLIF(
          (CASE WHEN subject.fpl_points_per_90 IS NOT NULL
             AND count(*) FILTER (WHERE peer.fpl_points_per_90 IS NOT NULL) > 0 THEN 1 ELSE 0 END)
          + (CASE WHEN subject.fpl_return_rate IS NOT NULL
             AND count(*) FILTER (WHERE peer.fpl_return_rate IS NOT NULL) > 0 THEN 1 ELSE 0 END)
          + (CASE WHEN subject.fpl_bonus_per_90 IS NOT NULL
             AND count(*) FILTER (WHERE peer.fpl_bonus_per_90 IS NOT NULL) > 0 THEN 1 ELSE 0 END),
          0
        ), 1) AS fpl_position_percentile
      FROM fpl_base peer
      WHERE peer.element_type = subject.element_type
        AND peer.fpl_minutes >= 900
    ) peer_stats ON true
  ),
  link_rows AS MATERIALIZED (
    SELECT
      subject.*,
      link.status::text AS link_status,
      link.left_entity_id,
      link.evidence AS link_evidence,
      link.updated_at AS link_updated_at
    FROM fpl_scored subject
    LEFT JOIN LATERAL (
      SELECT link.status, link.left_entity_id, link.evidence, link.updated_at
      FROM bridge.entity_links link
      WHERE link.entity_type = 'player'
        AND link.left_provider = 'understat'
        AND link.right_provider = 'fpl'
        AND link.right_entity_id = subject.player_code::text
      ORDER BY CASE link.status::text
        WHEN 'auto_verified' THEN 1
        WHEN 'manual_verified' THEN 1
        WHEN 'ambiguous' THEN 2
        WHEN 'quarantined' THEN 3
        ELSE 4
      END, link.updated_at DESC, link.created_at DESC
      LIMIT 1
    ) link ON true
  ),
  mapped_rows AS MATERIALIZED (
    SELECT
      subject.*,
      CASE
        WHEN subject.link_status IS NULL THEN 'UNAVAILABLE'
        WHEN subject.link_status = 'quarantined' THEN 'QUARANTINED'
        WHEN subject.link_status = 'ambiguous' THEN 'AMBIGUOUS'
        WHEN subject.link_status IN ('auto_verified', 'manual_verified')
          AND (subject.link_evidence -> 'confirmedSeasons') ? subject.season_code
          THEN 'VERIFIED'
        ELSE 'UNVERIFIED'
      END AS understat_mapping_status
    FROM link_rows subject
  ),
  understat_base AS MATERIALIZED (
    SELECT
      subject.season_id,
      subject.season_code,
      subject.player_code,
      subject.element_type,
      subject.understat_mapping_status,
      metrics.player_id AS understat_player_id,
      provider_season.state::text AS understat_season_state,
      metrics.time_minutes AS understat_minutes,
      (metrics.non_penalty_xg * 90) / NULLIF(metrics.time_minutes, 0) AS understat_npxg_per_90,
      (metrics.xa * 90) / NULLIF(metrics.time_minutes, 0) AS understat_xa_per_90,
      (metrics.shots::numeric * 90) / NULLIF(metrics.time_minutes, 0) AS understat_shots_per_90,
      (metrics.key_passes::numeric * 90) / NULLIF(metrics.time_minutes, 0) AS understat_key_passes_per_90,
      (metrics.xg_chain * 90) / NULLIF(metrics.time_minutes, 0) AS understat_xg_chain_per_90,
      (metrics.xg_buildup * 90) / NULLIF(metrics.time_minutes, 0) AS understat_xg_buildup_per_90,
      metrics.source_hash AS understat_source_hash,
      metrics.updated_at AS understat_source_updated_at
    FROM mapped_rows subject
    JOIN understat.player_seasons metrics
      ON metrics.season_code = subject.season_code
     AND metrics.player_id = CASE
       WHEN subject.left_entity_id ~ '^[0-9]+$' THEN subject.left_entity_id::integer
     END
    JOIN understat.seasons provider_season
      ON provider_season.season_code = metrics.season_code
     AND provider_season.state::text IN ('active', 'complete')
    WHERE subject.understat_mapping_status = 'VERIFIED'
  ),
  understat_scored AS MATERIALIZED (
    SELECT
      subject.*,
      peer_stats.understat_peer_count,
      peer_stats.understat_npxg_percentile,
      peer_stats.understat_xa_percentile,
      peer_stats.understat_shots_percentile,
      peer_stats.understat_key_passes_percentile,
      peer_stats.understat_xg_chain_percentile,
      peer_stats.understat_xg_buildup_percentile
    FROM understat_base subject
    LEFT JOIN LATERAL (
      SELECT
        count(*)::integer AS understat_peer_count,
        CASE WHEN subject.understat_npxg_per_90 IS NOT NULL
              AND count(*) FILTER (WHERE peer.understat_npxg_per_90 IS NOT NULL) > 0
          THEN round((
            (count(*) FILTER (WHERE peer.understat_npxg_per_90 < subject.understat_npxg_per_90)
              + count(*) FILTER (WHERE peer.understat_npxg_per_90 = subject.understat_npxg_per_90) * 0.5
            )::numeric / count(*) FILTER (WHERE peer.understat_npxg_per_90 IS NOT NULL)
          ) * 100, 1)
        END AS understat_npxg_percentile,
        CASE WHEN subject.understat_xa_per_90 IS NOT NULL
              AND count(*) FILTER (WHERE peer.understat_xa_per_90 IS NOT NULL) > 0
          THEN round((
            (count(*) FILTER (WHERE peer.understat_xa_per_90 < subject.understat_xa_per_90)
              + count(*) FILTER (WHERE peer.understat_xa_per_90 = subject.understat_xa_per_90) * 0.5
            )::numeric / count(*) FILTER (WHERE peer.understat_xa_per_90 IS NOT NULL)
          ) * 100, 1)
        END AS understat_xa_percentile,
        CASE WHEN subject.understat_shots_per_90 IS NOT NULL
              AND count(*) FILTER (WHERE peer.understat_shots_per_90 IS NOT NULL) > 0
          THEN round((
            (count(*) FILTER (WHERE peer.understat_shots_per_90 < subject.understat_shots_per_90)
              + count(*) FILTER (WHERE peer.understat_shots_per_90 = subject.understat_shots_per_90) * 0.5
            )::numeric / count(*) FILTER (WHERE peer.understat_shots_per_90 IS NOT NULL)
          ) * 100, 1)
        END AS understat_shots_percentile,
        CASE WHEN subject.understat_key_passes_per_90 IS NOT NULL
              AND count(*) FILTER (WHERE peer.understat_key_passes_per_90 IS NOT NULL) > 0
          THEN round((
            (count(*) FILTER (WHERE peer.understat_key_passes_per_90 < subject.understat_key_passes_per_90)
              + count(*) FILTER (WHERE peer.understat_key_passes_per_90 = subject.understat_key_passes_per_90) * 0.5
            )::numeric / count(*) FILTER (WHERE peer.understat_key_passes_per_90 IS NOT NULL)
          ) * 100, 1)
        END AS understat_key_passes_percentile,
        CASE WHEN subject.understat_xg_chain_per_90 IS NOT NULL
              AND count(*) FILTER (WHERE peer.understat_xg_chain_per_90 IS NOT NULL) > 0
          THEN round((
            (count(*) FILTER (WHERE peer.understat_xg_chain_per_90 < subject.understat_xg_chain_per_90)
              + count(*) FILTER (WHERE peer.understat_xg_chain_per_90 = subject.understat_xg_chain_per_90) * 0.5
            )::numeric / count(*) FILTER (WHERE peer.understat_xg_chain_per_90 IS NOT NULL)
          ) * 100, 1)
        END AS understat_xg_chain_percentile,
        CASE WHEN subject.understat_xg_buildup_per_90 IS NOT NULL
              AND count(*) FILTER (WHERE peer.understat_xg_buildup_per_90 IS NOT NULL) > 0
          THEN round((
            (count(*) FILTER (WHERE peer.understat_xg_buildup_per_90 < subject.understat_xg_buildup_per_90)
              + count(*) FILTER (WHERE peer.understat_xg_buildup_per_90 = subject.understat_xg_buildup_per_90) * 0.5
            )::numeric / count(*) FILTER (WHERE peer.understat_xg_buildup_per_90 IS NOT NULL)
          ) * 100, 1)
        END AS understat_xg_buildup_percentile
      FROM understat_base peer
      WHERE peer.season_code = subject.season_code
        AND peer.element_type = subject.element_type
        AND peer.understat_minutes >= 450
    ) peer_stats ON true
  ),
  final_rows AS MATERIALIZED (
    SELECT
      subject.*,
      COALESCE(understat.understat_player_id, NULL) AS understat_player_id,
      understat.understat_season_state,
      understat.understat_minutes,
      understat.understat_npxg_per_90,
      understat.understat_xa_per_90,
      understat.understat_shots_per_90,
      understat.understat_key_passes_per_90,
      understat.understat_xg_chain_per_90,
      understat.understat_xg_buildup_per_90,
      understat.understat_npxg_percentile,
      understat.understat_xa_percentile,
      understat.understat_shots_percentile,
      understat.understat_key_passes_percentile,
      understat.understat_xg_chain_percentile,
      understat.understat_xg_buildup_percentile,
      understat.understat_source_hash,
      understat.understat_source_updated_at,
      understat.understat_peer_count,
      CASE
        WHEN understat.understat_player_id IS NULL THEN NULL
        ELSE round((
          COALESCE(understat.understat_npxg_percentile, 0)
          + COALESCE(understat.understat_xa_percentile, 0)
          + COALESCE(understat.understat_shots_percentile, 0)
          + COALESCE(understat.understat_key_passes_percentile, 0)
          + COALESCE(understat.understat_xg_chain_percentile, 0)
          + COALESCE(understat.understat_xg_buildup_percentile, 0)
        ) / NULLIF(
          (understat.understat_npxg_percentile IS NOT NULL)::integer
          + (understat.understat_xa_percentile IS NOT NULL)::integer
          + (understat.understat_shots_percentile IS NOT NULL)::integer
          + (understat.understat_key_passes_percentile IS NOT NULL)::integer
          + (understat.understat_xg_chain_percentile IS NOT NULL)::integer
          + (understat.understat_xg_buildup_percentile IS NOT NULL)::integer,
          0
        ), 1)
      END AS understat_process_percentile
    FROM mapped_rows subject
    LEFT JOIN understat_scored understat
      ON understat.season_code = subject.season_code
     AND understat.player_code = subject.player_code
  )
  INSERT INTO pg_temp.player_state_season_candidates (
    season_id,
    season_code,
    lifecycle_state,
    player_code,
    element_id,
    element_type,
    fpl_total_points,
    fpl_starts,
    fpl_clean_sheets,
    fpl_saves,
    fpl_minutes,
    fpl_gameweeks,
    fpl_points_per_90,
    fpl_return_rate,
    fpl_bonus_per_90,
    fpl_position_percentile,
    fpl_peer_count,
    expected_metrics_available,
    fpl_source_hash,
    fpl_source_updated_at,
    understat_mapping_status,
    understat_player_id,
    understat_season_state,
    understat_minutes,
    understat_npxg_per_90,
    understat_xa_per_90,
    understat_shots_per_90,
    understat_key_passes_per_90,
    understat_xg_chain_per_90,
    understat_xg_buildup_per_90,
    understat_npxg_percentile,
    understat_xa_percentile,
    understat_shots_percentile,
    understat_key_passes_percentile,
    understat_xg_chain_percentile,
    understat_xg_buildup_percentile,
    understat_process_percentile,
    understat_peer_count,
    understat_source_hash,
    understat_source_updated_at,
    refreshed_at
  )
  SELECT
    row.season_id,
    row.season_code,
    row.lifecycle_state,
    row.player_code,
    row.element_id,
    row.element_type,
    row.fpl_total_points,
    row.fpl_starts,
    row.fpl_clean_sheets,
    row.fpl_saves,
    row.fpl_minutes,
    row.fpl_gameweeks,
    row.fpl_points_per_90,
    row.fpl_return_rate,
    row.fpl_bonus_per_90,
    row.fpl_position_percentile,
    row.fpl_peer_count,
    row.expected_metrics_available,
    row.fpl_source_hash,
    row.fpl_source_updated_at,
    row.understat_mapping_status,
    row.understat_player_id,
    row.understat_season_state,
    row.understat_minutes,
    row.understat_npxg_per_90,
    row.understat_xa_per_90,
    row.understat_shots_per_90,
    row.understat_key_passes_per_90,
    row.understat_xg_chain_per_90,
    row.understat_xg_buildup_per_90,
    row.understat_npxg_percentile,
    row.understat_xa_percentile,
    row.understat_shots_percentile,
    row.understat_key_passes_percentile,
    row.understat_xg_chain_percentile,
    row.understat_xg_buildup_percentile,
    row.understat_process_percentile,
    COALESCE(row.understat_peer_count, 0),
    row.understat_source_hash,
    row.understat_source_updated_at,
    refresh_time
  FROM final_rows row;

  INSERT INTO reporting.player_state_season_rows AS existing_row (
    season_id,
    season_code,
    lifecycle_state,
    player_code,
    element_id,
    element_type,
    fpl_total_points,
    fpl_starts,
    fpl_clean_sheets,
    fpl_saves,
    fpl_minutes,
    fpl_gameweeks,
    fpl_points_per_90,
    fpl_return_rate,
    fpl_bonus_per_90,
    fpl_position_percentile,
    fpl_peer_count,
    expected_metrics_available,
    fpl_source_hash,
    fpl_source_updated_at,
    understat_mapping_status,
    understat_player_id,
    understat_season_state,
    understat_minutes,
    understat_npxg_per_90,
    understat_xa_per_90,
    understat_shots_per_90,
    understat_key_passes_per_90,
    understat_xg_chain_per_90,
    understat_xg_buildup_per_90,
    understat_npxg_percentile,
    understat_xa_percentile,
    understat_shots_percentile,
    understat_key_passes_percentile,
    understat_xg_chain_percentile,
    understat_xg_buildup_percentile,
    understat_process_percentile,
    understat_peer_count,
    understat_source_hash,
    understat_source_updated_at,
    refreshed_at
  )
  SELECT
    candidate.season_id,
    candidate.season_code,
    candidate.lifecycle_state,
    candidate.player_code,
    candidate.element_id,
    candidate.element_type,
    candidate.fpl_total_points,
    candidate.fpl_starts,
    candidate.fpl_clean_sheets,
    candidate.fpl_saves,
    candidate.fpl_minutes,
    candidate.fpl_gameweeks,
    candidate.fpl_points_per_90,
    candidate.fpl_return_rate,
    candidate.fpl_bonus_per_90,
    candidate.fpl_position_percentile,
    candidate.fpl_peer_count,
    candidate.expected_metrics_available,
    candidate.fpl_source_hash,
    candidate.fpl_source_updated_at,
    candidate.understat_mapping_status,
    candidate.understat_player_id,
    candidate.understat_season_state,
    candidate.understat_minutes,
    candidate.understat_npxg_per_90,
    candidate.understat_xa_per_90,
    candidate.understat_shots_per_90,
    candidate.understat_key_passes_per_90,
    candidate.understat_xg_chain_per_90,
    candidate.understat_xg_buildup_per_90,
    candidate.understat_npxg_percentile,
    candidate.understat_xa_percentile,
    candidate.understat_shots_percentile,
    candidate.understat_key_passes_percentile,
    candidate.understat_xg_chain_percentile,
    candidate.understat_xg_buildup_percentile,
    candidate.understat_process_percentile,
    candidate.understat_peer_count,
    candidate.understat_source_hash,
    candidate.understat_source_updated_at,
    candidate.refreshed_at
  FROM pg_temp.player_state_season_candidates candidate
  ON CONFLICT (season_id, player_code) DO UPDATE SET
    season_code = excluded.season_code,
    lifecycle_state = excluded.lifecycle_state,
    element_id = excluded.element_id,
    element_type = excluded.element_type,
    fpl_total_points = excluded.fpl_total_points,
    fpl_starts = excluded.fpl_starts,
    fpl_clean_sheets = excluded.fpl_clean_sheets,
    fpl_saves = excluded.fpl_saves,
    fpl_minutes = excluded.fpl_minutes,
    fpl_gameweeks = excluded.fpl_gameweeks,
    fpl_points_per_90 = excluded.fpl_points_per_90,
    fpl_return_rate = excluded.fpl_return_rate,
    fpl_bonus_per_90 = excluded.fpl_bonus_per_90,
    fpl_position_percentile = excluded.fpl_position_percentile,
    fpl_peer_count = excluded.fpl_peer_count,
    expected_metrics_available = excluded.expected_metrics_available,
    fpl_source_hash = excluded.fpl_source_hash,
    fpl_source_updated_at = excluded.fpl_source_updated_at,
    understat_mapping_status = excluded.understat_mapping_status,
    understat_player_id = excluded.understat_player_id,
    understat_season_state = excluded.understat_season_state,
    understat_minutes = excluded.understat_minutes,
    understat_npxg_per_90 = excluded.understat_npxg_per_90,
    understat_xa_per_90 = excluded.understat_xa_per_90,
    understat_shots_per_90 = excluded.understat_shots_per_90,
    understat_key_passes_per_90 = excluded.understat_key_passes_per_90,
    understat_xg_chain_per_90 = excluded.understat_xg_chain_per_90,
    understat_xg_buildup_per_90 = excluded.understat_xg_buildup_per_90,
    understat_npxg_percentile = excluded.understat_npxg_percentile,
    understat_xa_percentile = excluded.understat_xa_percentile,
    understat_shots_percentile = excluded.understat_shots_percentile,
    understat_key_passes_percentile = excluded.understat_key_passes_percentile,
    understat_xg_chain_percentile = excluded.understat_xg_chain_percentile,
    understat_xg_buildup_percentile = excluded.understat_xg_buildup_percentile,
    understat_process_percentile = excluded.understat_process_percentile,
    understat_peer_count = excluded.understat_peer_count,
    understat_source_hash = excluded.understat_source_hash,
    understat_source_updated_at = excluded.understat_source_updated_at,
    refreshed_at = excluded.refreshed_at
  WHERE ROW(
    existing_row.season_code,
    existing_row.lifecycle_state,
    existing_row.element_id,
    existing_row.element_type,
    existing_row.fpl_total_points,
    existing_row.fpl_starts,
    existing_row.fpl_clean_sheets,
    existing_row.fpl_saves,
    existing_row.fpl_minutes,
    existing_row.fpl_gameweeks,
    existing_row.fpl_points_per_90,
    existing_row.fpl_return_rate,
    existing_row.fpl_bonus_per_90,
    existing_row.fpl_position_percentile,
    existing_row.fpl_peer_count,
    existing_row.expected_metrics_available,
    existing_row.fpl_source_hash,
    existing_row.fpl_source_updated_at,
    existing_row.understat_mapping_status,
    existing_row.understat_player_id,
    existing_row.understat_season_state,
    existing_row.understat_minutes,
    existing_row.understat_npxg_per_90,
    existing_row.understat_xa_per_90,
    existing_row.understat_shots_per_90,
    existing_row.understat_key_passes_per_90,
    existing_row.understat_xg_chain_per_90,
    existing_row.understat_xg_buildup_per_90,
    existing_row.understat_npxg_percentile,
    existing_row.understat_xa_percentile,
    existing_row.understat_shots_percentile,
    existing_row.understat_key_passes_percentile,
    existing_row.understat_xg_chain_percentile,
    existing_row.understat_xg_buildup_percentile,
    existing_row.understat_process_percentile,
    existing_row.understat_peer_count,
    existing_row.understat_source_hash,
    existing_row.understat_source_updated_at
  ) IS DISTINCT FROM ROW(
    excluded.season_code,
    excluded.lifecycle_state,
    excluded.element_id,
    excluded.element_type,
    excluded.fpl_total_points,
    excluded.fpl_starts,
    excluded.fpl_clean_sheets,
    excluded.fpl_saves,
    excluded.fpl_minutes,
    excluded.fpl_gameweeks,
    excluded.fpl_points_per_90,
    excluded.fpl_return_rate,
    excluded.fpl_bonus_per_90,
    excluded.fpl_position_percentile,
    excluded.fpl_peer_count,
    excluded.expected_metrics_available,
    excluded.fpl_source_hash,
    excluded.fpl_source_updated_at,
    excluded.understat_mapping_status,
    excluded.understat_player_id,
    excluded.understat_season_state,
    excluded.understat_minutes,
    excluded.understat_npxg_per_90,
    excluded.understat_xa_per_90,
    excluded.understat_shots_per_90,
    excluded.understat_key_passes_per_90,
    excluded.understat_xg_chain_per_90,
    excluded.understat_xg_buildup_per_90,
    excluded.understat_npxg_percentile,
    excluded.understat_xa_percentile,
    excluded.understat_shots_percentile,
    excluded.understat_key_passes_percentile,
    excluded.understat_xg_chain_percentile,
    excluded.understat_xg_buildup_percentile,
    excluded.understat_process_percentile,
    excluded.understat_peer_count,
    excluded.understat_source_hash,
    excluded.understat_source_updated_at
  );

  DELETE FROM reporting.player_state_season_rows existing_row
  WHERE existing_row.season_id = requested_season_id
    AND NOT EXISTS (
      SELECT 1
      FROM pg_temp.player_state_season_candidates candidate
      WHERE candidate.season_id = existing_row.season_id
        AND candidate.player_code = existing_row.player_code
    );

  SELECT count(*)::integer
  INTO refreshed_players
  FROM pg_temp.player_state_season_candidates;

  SELECT count(*) FILTER (WHERE understat_player_id IS NOT NULL)::integer
  INTO refreshed_understat_players
  FROM pg_temp.player_state_season_candidates;

  INSERT INTO reporting.player_state_season_refreshes (
    season_id,
    revision,
    fpl_source_updated_at,
    understat_source_updated_at,
    bridge_source_updated_at,
    source_updated_at,
    refreshed_at,
    player_count,
    understat_player_count
  ) VALUES (
    requested_season_id,
    1,
    fpl_source_time,
    understat_source_time,
    bridge_source_time,
    source_time,
    refresh_time,
    refreshed_players,
    refreshed_understat_players
  )
  ON CONFLICT (season_id) DO UPDATE SET
    revision = reporting.player_state_season_refreshes.revision + 1,
    fpl_source_updated_at = EXCLUDED.fpl_source_updated_at,
    understat_source_updated_at = EXCLUDED.understat_source_updated_at,
    bridge_source_updated_at = EXCLUDED.bridge_source_updated_at,
    source_updated_at = EXCLUDED.source_updated_at,
    refreshed_at = EXCLUDED.refreshed_at,
    player_count = EXCLUDED.player_count,
    understat_player_count = EXCLUDED.understat_player_count
  RETURNING reporting.player_state_season_refreshes.revision
  INTO revision;

  INSERT INTO reporting.player_state_dataset_metadata (
    dataset_key,
    revision,
    method_version,
    source_updated_at,
    refreshed_at
  ) VALUES (
    'player_state',
    1,
    '1',
    source_time,
    refresh_time
  )
  ON CONFLICT (dataset_key) DO UPDATE SET
    revision = reporting.player_state_dataset_metadata.revision + 1,
    method_version = EXCLUDED.method_version,
    source_updated_at = GREATEST(
      reporting.player_state_dataset_metadata.source_updated_at,
      EXCLUDED.source_updated_at
    ),
    refreshed_at = GREATEST(
      reporting.player_state_dataset_metadata.refreshed_at,
      EXCLUDED.refreshed_at
    )
  RETURNING reporting.player_state_dataset_metadata.revision
  INTO next_revision;

  RETURN QUERY SELECT next_revision, refreshed_players, refreshed_understat_players, source_time, refresh_time;
END;
$$;

ALTER FUNCTION reporting.refresh_player_state_season_full_rebuild(smallint)
  OWNER TO letletme_data_owner;
ALTER FUNCTION reporting.refresh_player_state_season(smallint)
  OWNER TO letletme_data_owner;
REVOKE EXECUTE ON FUNCTION reporting.refresh_player_state_season_full_rebuild(smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reporting.refresh_player_state_season_full_rebuild(smallint) TO letletme_data_writer;
REVOKE EXECUTE ON FUNCTION reporting.refresh_player_state_season(smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reporting.refresh_player_state_season(smallint) TO letletme_data_writer;
