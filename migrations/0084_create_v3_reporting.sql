-- Rebuildable reporting contracts: ordinary views for cheap derivations and
-- materialized views for expensive, repeatedly consumed tournament results.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL ROLE letletme_data_owner;

CREATE OR REPLACE VIEW reporting.player_season_summaries
WITH (security_invoker = true)
AS
SELECT
  player.season_id,
  player.element_id,
  player.element_type,
  count(stats.event_id)::integer AS gameweeks_available,
  count(*) FILTER (WHERE stats.starts IS TRUE)::integer AS gameweeks_started,
  COALESCE(sum(stats.minutes), 0)::integer AS minutes,
  COALESCE(sum(stats.goals_scored), 0)::integer AS goals_scored,
  COALESCE(sum(stats.assists), 0)::integer AS assists,
  COALESCE(sum(stats.clean_sheets), 0)::integer AS clean_sheets,
  COALESCE(sum(stats.goals_conceded), 0)::integer AS goals_conceded,
  COALESCE(sum(stats.own_goals), 0)::integer AS own_goals,
  COALESCE(sum(stats.penalties_saved), 0)::integer AS penalties_saved,
  COALESCE(sum(stats.penalties_missed), 0)::integer AS penalties_missed,
  COALESCE(sum(stats.yellow_cards), 0)::integer AS yellow_cards,
  COALESCE(sum(stats.red_cards), 0)::integer AS red_cards,
  COALESCE(sum(stats.saves), 0)::integer AS saves,
  COALESCE(sum(stats.bonus), 0)::integer AS bonus,
  COALESCE(sum(stats.bps), 0)::integer AS bps,
  COALESCE(sum(stats.total_points), 0)::integer AS total_points,
  COALESCE(sum(stats.defensive_contribution), 0)::integer AS defensive_contribution,
  COALESCE(sum(stats.expected_goals), 0::numeric) AS expected_goals,
  COALESCE(sum(stats.expected_assists), 0::numeric) AS expected_assists,
  COALESCE(sum(stats.expected_goal_involvements), 0::numeric) AS expected_goal_involvements,
  COALESCE(sum(stats.expected_goals_conceded), 0::numeric) AS expected_goals_conceded,
  count(*) FILTER (WHERE stats.in_dream_team IS TRUE)::integer AS dream_team_appearances
FROM fpl.players player
LEFT JOIN fpl.player_gameweek_stats stats
  ON stats.season_id = player.season_id
 AND stats.element_id = player.element_id
GROUP BY player.season_id, player.element_id, player.element_type;

CREATE OR REPLACE VIEW reporting.player_value_changes
WITH (security_invoker = true)
AS
WITH ordered_snapshots AS (
  SELECT
    snapshot.season_id,
    snapshot.snapshot_date,
    snapshot.element_id,
    snapshot.element_type,
    snapshot.price,
    snapshot.snapshot_source,
    snapshot.source_value_id,
    snapshot.source_event_id,
    lag(snapshot.price) OVER (
      PARTITION BY snapshot.season_id, snapshot.element_id
      ORDER BY snapshot.snapshot_date
    ) AS previous_price,
    row_number() OVER (
      PARTITION BY snapshot.season_id, snapshot.element_id
      ORDER BY snapshot.snapshot_date
    ) AS snapshot_number
  FROM fpl.player_market_snapshots snapshot
), changed_snapshots AS (
  SELECT ordered.*
  FROM ordered_snapshots ordered
  WHERE ordered.snapshot_number = 1
     OR ordered.price IS DISTINCT FROM ordered.previous_price
)
SELECT
  changed.season_id,
  season.season_code,
  changed.snapshot_date,
  changed.element_id,
  changed.element_type,
  COALESCE(changed.source_event_id, event.event_id) AS event_id,
  changed.price AS value,
  CASE WHEN changed.snapshot_number = 1 THEN 0 ELSE changed.previous_price END AS last_value,
  CASE
    WHEN changed.snapshot_number = 1 THEN 'start'
    WHEN changed.price > changed.previous_price THEN 'rise'
    ELSE 'fall'
  END AS change_type,
  CASE WHEN changed.snapshot_number = 1 THEN changed.price ELSE changed.price - changed.previous_price END
    AS value_change,
  changed.snapshot_source,
  changed.source_value_id
FROM changed_snapshots changed
JOIN fpl.seasons season ON season.season_id = changed.season_id
LEFT JOIN fpl.events event
  ON event.season_id = changed.season_id
 AND event.deadline_time::date = changed.snapshot_date;

CREATE OR REPLACE VIEW reporting.tournament_event_results
WITH (security_invoker = true)
AS
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
    WHEN side.match_points IS NULL OR side.opponent_match_points IS NULL THEN NULL
    ELSE side.match_points > side.opponent_match_points
  END AS is_winner,
  battle.created_at,
  battle.updated_at
FROM competition.tournament_battle_group_results battle
CROSS JOIN LATERAL (
  VALUES
    (
      battle.home_entry_id,
      battle.away_entry_id,
      battle.home_net_points,
      battle.home_rank,
      battle.home_match_points,
      battle.away_match_points
    ),
    (
      battle.away_entry_id,
      battle.home_entry_id,
      battle.away_net_points,
      battle.away_rank,
      battle.away_match_points,
      battle.home_match_points
    )
) AS side(entry_id, opponent_entry_id, net_points, event_rank, match_points, opponent_match_points)

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
    WHEN knockout.match_winner IS NULL OR side.entry_id IS NULL THEN NULL
    ELSE knockout.match_winner = side.entry_id
  END AS is_winner,
  knockout.created_at,
  knockout.updated_at
FROM competition.tournament_knockout_results knockout
CROSS JOIN LATERAL (
  VALUES
    (
      knockout.home_entry_id,
      knockout.away_entry_id,
      knockout.home_net_points,
      knockout.home_goals_scored,
      knockout.home_goals_conceded
    ),
    (
      knockout.away_entry_id,
      knockout.home_entry_id,
      knockout.away_net_points,
      knockout.away_goals_scored,
      knockout.away_goals_conceded
    )
) AS side(entry_id, opponent_entry_id, net_points, goals_for, goals_against)
WHERE side.entry_id IS NOT NULL;

CREATE MATERIALIZED VIEW IF NOT EXISTS reporting.tournament_selection_stats AS
WITH expected_entries AS (
  SELECT
    entry.tournament_id,
    entry.season_id,
    count(*)::integer AS total_entries
  FROM competition.tournament_entries entry
  GROUP BY entry.tournament_id, entry.season_id
), candidate_events AS (
  SELECT DISTINCT
    entry.tournament_id,
    entry.season_id,
    pick.event_id
  FROM competition.tournament_entries entry
  JOIN competition.entry_event_picks pick
    ON pick.season_id = entry.season_id
   AND pick.entry_id = entry.entry_id
), valid_entry_events AS (
  SELECT
    entry.tournament_id,
    entry.season_id,
    pick.event_id,
    entry.entry_id
  FROM competition.tournament_entries entry
  JOIN competition.entry_event_picks pick
    ON pick.season_id = entry.season_id
   AND pick.entry_id = entry.entry_id
  GROUP BY entry.tournament_id, entry.season_id, pick.event_id, entry.entry_id
  HAVING count(*) = 15
     AND min(pick.position) = 1
     AND max(pick.position) = 15
     AND count(*) FILTER (WHERE pick.is_captain) = 1
     AND count(*) FILTER (WHERE pick.is_vice_captain) = 1
), complete_scopes AS (
  SELECT
    event.tournament_id,
    event.season_id,
    event.event_id,
    expected.total_entries
  FROM candidate_events event
  JOIN expected_entries expected
    ON expected.tournament_id = event.tournament_id
   AND expected.season_id = event.season_id
  LEFT JOIN valid_entry_events valid
    ON valid.tournament_id = event.tournament_id
   AND valid.season_id = event.season_id
   AND valid.event_id = event.event_id
  GROUP BY event.tournament_id, event.season_id, event.event_id, expected.total_entries
  HAVING expected.total_entries > 0
     AND count(valid.entry_id) = expected.total_entries
), eligible_picks AS (
  SELECT
    scope.tournament_id,
    scope.season_id,
    scope.event_id,
    scope.total_entries,
    pick.entry_id,
    pick.element_id,
    pick.multiplier,
    pick.is_captain,
    pick.is_vice_captain
  FROM complete_scopes scope
  JOIN competition.tournament_entries entry
    ON entry.tournament_id = scope.tournament_id
   AND entry.season_id = scope.season_id
  JOIN competition.entry_event_picks pick
    ON pick.season_id = entry.season_id
   AND pick.entry_id = entry.entry_id
   AND pick.event_id = scope.event_id
), pick_stats AS (
  SELECT
    pick.tournament_id,
    pick.season_id,
    pick.event_id,
    pick.total_entries,
    pick.element_id,
    count(*)::integer AS selected_count,
    count(*) FILTER (WHERE pick.is_captain)::integer AS captain_count,
    count(*) FILTER (WHERE pick.is_vice_captain)::integer AS vice_captain_count,
    sum(pick.multiplier)::integer AS effective_selection_count
  FROM eligible_picks pick
  GROUP BY pick.tournament_id, pick.season_id, pick.event_id, pick.total_entries, pick.element_id
), transfer_stats AS (
  SELECT
    scope.tournament_id,
    scope.season_id,
    scope.event_id,
    transfer.element_id,
    sum(transfer.transfer_in_count)::integer AS transfer_in_count,
    sum(transfer.transfer_out_count)::integer AS transfer_out_count
  FROM complete_scopes scope
  JOIN competition.tournament_entries entry
    ON entry.tournament_id = scope.tournament_id
   AND entry.season_id = scope.season_id
  JOIN LATERAL (
    SELECT
      element.element_id,
      count(*) FILTER (WHERE element.direction = 'in') AS transfer_in_count,
      count(*) FILTER (WHERE element.direction = 'out') AS transfer_out_count
    FROM competition.entry_event_transfers source_transfer
    CROSS JOIN LATERAL (
      VALUES
        (source_transfer.element_in_id, 'in'::text),
        (source_transfer.element_out_id, 'out'::text)
    ) AS element(element_id, direction)
    WHERE source_transfer.season_id = entry.season_id
      AND source_transfer.entry_id = entry.entry_id
      AND source_transfer.event_id = scope.event_id
      AND element.element_id IS NOT NULL
    GROUP BY element.element_id
  ) transfer ON true
  GROUP BY scope.tournament_id, scope.season_id, scope.event_id, transfer.element_id
), elements AS (
  SELECT tournament_id, season_id, event_id, element_id FROM pick_stats
  UNION
  SELECT tournament_id, season_id, event_id, element_id FROM transfer_stats
)
SELECT
  element.tournament_id,
  element.season_id,
  element.event_id,
  element.element_id,
  scope.total_entries,
  COALESCE(pick.selected_count, 0)::integer AS selected_count,
  COALESCE(pick.captain_count, 0)::integer AS captain_count,
  COALESCE(pick.vice_captain_count, 0)::integer AS vice_captain_count,
  COALESCE(pick.effective_selection_count, 0)::integer AS effective_selection_count,
  COALESCE(transfer.transfer_in_count, 0)::integer AS transfer_in_count,
  COALESCE(transfer.transfer_out_count, 0)::integer AS transfer_out_count,
  round(COALESCE(pick.selected_count, 0)::numeric * 100 / NULLIF(scope.total_entries, 0), 4)
    AS selection_percentage,
  round(COALESCE(pick.captain_count, 0)::numeric * 100 / NULLIF(scope.total_entries, 0), 4)
    AS captain_percentage,
  round(COALESCE(pick.vice_captain_count, 0)::numeric * 100 / NULLIF(scope.total_entries, 0), 4)
    AS vice_captain_percentage,
  round(COALESCE(pick.effective_selection_count, 0)::numeric * 100 / NULLIF(scope.total_entries, 0), 4)
    AS effective_ownership_percentage
FROM elements element
JOIN complete_scopes scope
  ON scope.tournament_id = element.tournament_id
 AND scope.season_id = element.season_id
 AND scope.event_id = element.event_id
LEFT JOIN pick_stats pick
  ON pick.tournament_id = element.tournament_id
 AND pick.season_id = element.season_id
 AND pick.event_id = element.event_id
 AND pick.element_id = element.element_id
LEFT JOIN transfer_stats transfer
  ON transfer.tournament_id = element.tournament_id
 AND transfer.season_id = element.season_id
 AND transfer.event_id = element.event_id
 AND transfer.element_id = element.element_id
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS tournament_selection_stats_grain_idx
  ON reporting.tournament_selection_stats (tournament_id, event_id, element_id);
CREATE INDEX IF NOT EXISTS tournament_selection_stats_selected_idx
  ON reporting.tournament_selection_stats (tournament_id, event_id, selected_count DESC, element_id);
CREATE INDEX IF NOT EXISTS tournament_selection_stats_captain_idx
  ON reporting.tournament_selection_stats (tournament_id, event_id, captain_count DESC, element_id);
CREATE INDEX IF NOT EXISTS tournament_selection_stats_transfer_in_idx
  ON reporting.tournament_selection_stats (tournament_id, event_id, transfer_in_count DESC, element_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS reporting.tournament_entry_event_summaries AS
WITH expected_entries AS (
  SELECT tournament_id, season_id, count(*)::integer AS total_entries
  FROM competition.tournament_entries
  GROUP BY tournament_id, season_id
), valid_entry_events AS (
  SELECT
    entry.tournament_id,
    entry.season_id,
    pick.event_id,
    entry.entry_id
  FROM competition.tournament_entries entry
  JOIN competition.entry_event_picks pick
    ON pick.season_id = entry.season_id
   AND pick.entry_id = entry.entry_id
  GROUP BY entry.tournament_id, entry.season_id, pick.event_id, entry.entry_id
  HAVING count(*) = 15
     AND min(pick.position) = 1
     AND max(pick.position) = 15
     AND count(*) FILTER (WHERE pick.is_captain) = 1
     AND count(*) FILTER (WHERE pick.is_vice_captain) = 1
), complete_scopes AS (
  SELECT
    valid.tournament_id,
    valid.season_id,
    valid.event_id,
    expected.total_entries
  FROM valid_entry_events valid
  JOIN expected_entries expected
    ON expected.tournament_id = valid.tournament_id
   AND expected.season_id = valid.season_id
  GROUP BY valid.tournament_id, valid.season_id, valid.event_id, expected.total_entries
  HAVING expected.total_entries > 0 AND count(*) = expected.total_entries
), pick_aggregates AS (
  SELECT
    entry.tournament_id,
    pick.season_id,
    pick.event_id,
    pick.entry_id,
    count(*)::integer AS pick_count,
    sum(pick.multiplier * COALESCE(stats.total_points, 0))::integer AS selection_points,
    sum(CASE WHEN pick.multiplier = 0 THEN COALESCE(stats.total_points, 0) ELSE 0 END)::integer
      AS calculated_bench_points,
    sum(CASE WHEN player.element_type = 1 THEN pick.multiplier * COALESCE(stats.total_points, 0) ELSE 0 END)::integer
      AS goalkeeper_points,
    sum(CASE WHEN player.element_type = 2 THEN pick.multiplier * COALESCE(stats.total_points, 0) ELSE 0 END)::integer
      AS defender_points,
    sum(CASE WHEN player.element_type = 3 THEN pick.multiplier * COALESCE(stats.total_points, 0) ELSE 0 END)::integer
      AS midfielder_points,
    sum(CASE WHEN player.element_type = 4 THEN pick.multiplier * COALESCE(stats.total_points, 0) ELSE 0 END)::integer
      AS forward_points,
    max(pick.element_id) FILTER (WHERE pick.is_captain) AS captain_element_id,
    max(pick.element_id) FILTER (WHERE pick.is_vice_captain) AS vice_captain_element_id
  FROM competition.tournament_entries entry
  JOIN competition.entry_event_picks pick
    ON pick.season_id = entry.season_id
   AND pick.entry_id = entry.entry_id
  JOIN fpl.players player
    ON player.season_id = pick.season_id
   AND player.element_id = pick.element_id
  LEFT JOIN fpl.player_gameweek_stats stats
    ON stats.season_id = pick.season_id
   AND stats.event_id = pick.event_id
   AND stats.element_id = pick.element_id
  GROUP BY entry.tournament_id, pick.season_id, pick.event_id, pick.entry_id
), transfer_aggregates AS (
  SELECT
    entry.tournament_id,
    transfer.season_id,
    transfer.event_id,
    transfer.entry_id,
    count(*)::integer AS transfer_count
  FROM competition.tournament_entries entry
  JOIN competition.entry_event_transfers transfer
    ON transfer.season_id = entry.season_id
   AND transfer.entry_id = entry.entry_id
  GROUP BY entry.tournament_id, transfer.season_id, transfer.event_id, transfer.entry_id
), base AS (
  SELECT
    entry.tournament_id,
    result.season_id,
    result.event_id,
    result.entry_id,
    scope.total_entries,
    result.event_points,
    result.event_transfers,
    result.event_transfers_cost,
    result.event_net_points,
    result.event_bench_points,
    result.event_auto_sub_points,
    result.event_rank,
    result.event_chip,
    result.played_captain_element_id,
    result.captain_points,
    result.overall_points,
    result.overall_rank,
    result.team_value,
    result.bank,
    pick.pick_count,
    pick.selection_points,
    pick.calculated_bench_points,
    pick.goalkeeper_points,
    pick.defender_points,
    pick.midfielder_points,
    pick.forward_points,
    pick.captain_element_id,
    pick.vice_captain_element_id,
    COALESCE(transfer.transfer_count, 0)::integer AS transfer_row_count,
    event.live_snapshot_finalized_at AS source_finalized_at
  FROM complete_scopes scope
  JOIN competition.tournament_entries entry
    ON entry.tournament_id = scope.tournament_id
   AND entry.season_id = scope.season_id
  JOIN competition.entry_event_results result
    ON result.season_id = entry.season_id
   AND result.entry_id = entry.entry_id
   AND result.event_id = scope.event_id
   AND result.rich_synced_at IS NOT NULL
  JOIN fpl.events event
    ON event.season_id = result.season_id
   AND event.event_id = result.event_id
   AND event.finished
   AND event.data_checked
   AND event.live_snapshot_finalized_at IS NOT NULL
  JOIN pick_aggregates pick
    ON pick.tournament_id = entry.tournament_id
   AND pick.season_id = result.season_id
   AND pick.event_id = result.event_id
   AND pick.entry_id = result.entry_id
  LEFT JOIN transfer_aggregates transfer
    ON transfer.tournament_id = entry.tournament_id
   AND transfer.season_id = result.season_id
   AND transfer.event_id = result.event_id
   AND transfer.entry_id = result.entry_id
)
SELECT
  base.*,
  rank() OVER (
    PARTITION BY base.tournament_id, base.event_id
    ORDER BY base.event_net_points DESC, base.entry_id
  ) AS tournament_event_rank,
  sum(base.event_net_points) OVER (
    PARTITION BY base.tournament_id, base.entry_id
    ORDER BY base.event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  )::integer AS cumulative_net_points,
  sum(base.event_transfers) OVER (
    PARTITION BY base.tournament_id, base.entry_id
    ORDER BY base.event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  )::integer AS cumulative_transfers,
  sum(base.event_transfers_cost) OVER (
    PARTITION BY base.tournament_id, base.entry_id
    ORDER BY base.event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  )::integer AS cumulative_transfer_cost,
  sum(COALESCE(base.event_bench_points, 0)) OVER (
    PARTITION BY base.tournament_id, base.entry_id
    ORDER BY base.event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  )::integer AS cumulative_bench_points,
  sum(COALESCE(base.event_auto_sub_points, 0)) OVER (
    PARTITION BY base.tournament_id, base.entry_id
    ORDER BY base.event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  )::integer AS cumulative_auto_sub_points,
  sum(COALESCE(base.captain_points, 0)) OVER (
    PARTITION BY base.tournament_id, base.entry_id
    ORDER BY base.event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  )::integer AS cumulative_captain_points
FROM base
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS tournament_entry_event_summaries_grain_idx
  ON reporting.tournament_entry_event_summaries (tournament_id, event_id, entry_id);
CREATE INDEX IF NOT EXISTS tournament_entry_event_summaries_rank_idx
  ON reporting.tournament_entry_event_summaries (tournament_id, event_id, tournament_event_rank);
CREATE INDEX IF NOT EXISTS tournament_entry_event_summaries_entry_idx
  ON reporting.tournament_entry_event_summaries (tournament_id, entry_id, event_id);

CREATE OR REPLACE FUNCTION reporting.refresh_tournament_selection_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(73001, 1);
  REFRESH MATERIALIZED VIEW CONCURRENTLY reporting.tournament_selection_stats;
END
$function$;

CREATE OR REPLACE FUNCTION reporting.refresh_tournament_entry_event_summaries()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(73001, 2);
  REFRESH MATERIALIZED VIEW CONCURRENTLY reporting.tournament_entry_event_summaries;
END
$function$;

ALTER FUNCTION reporting.refresh_tournament_selection_stats() OWNER TO letletme_data_owner;
ALTER FUNCTION reporting.refresh_tournament_entry_event_summaries() OWNER TO letletme_data_owner;

REVOKE ALL ON
  reporting.player_season_summaries,
  reporting.player_value_changes,
  reporting.tournament_event_results,
  reporting.tournament_selection_stats,
  reporting.tournament_entry_event_summaries
FROM PUBLIC;

REVOKE ALL ON FUNCTION reporting.refresh_tournament_selection_stats() FROM PUBLIC;
REVOKE ALL ON FUNCTION reporting.refresh_tournament_entry_event_summaries() FROM PUBLIC;

GRANT SELECT ON
  reporting.player_season_summaries,
  reporting.player_value_changes,
  reporting.tournament_event_results,
  reporting.tournament_selection_stats,
  reporting.tournament_entry_event_summaries
TO letletme_graphql_reader;

-- Data refreshes and validates only the two materialized operational read
-- models. Ordinary reporting views remain GraphQL-only.
GRANT SELECT ON
  reporting.tournament_selection_stats,
  reporting.tournament_entry_event_summaries
TO letletme_data_writer;

GRANT EXECUTE ON FUNCTION reporting.refresh_tournament_selection_stats()
TO letletme_data_writer;
GRANT EXECUTE ON FUNCTION reporting.refresh_tournament_entry_event_summaries()
TO letletme_data_writer;

RESET ROLE;
