-- Tournament event reporting is scoped to managers who had started playing by
-- that event. A manager added to a tournament in GW2 has no authoritative GW1
-- picks, so they must not block or dilute the completed GW1 reporting scope.

DROP MATERIALIZED VIEW reporting.tournament_entry_event_summaries;

CREATE MATERIALIZED VIEW reporting.tournament_entry_event_summaries AS
WITH candidate_events AS (
  SELECT DISTINCT
    roster.tournament_id,
    roster.season_id,
    pick.event_id
  FROM competition.tournament_entries roster
  JOIN competition.entry_event_picks pick
    ON pick.season_id = roster.season_id
   AND pick.entry_id = roster.entry_id
), eligible_entries AS (
  SELECT
    candidate.tournament_id,
    candidate.season_id,
    candidate.event_id,
    roster.entry_id
  FROM candidate_events candidate
  JOIN competition.tournament_entries roster
    ON roster.tournament_id = candidate.tournament_id
   AND roster.season_id = candidate.season_id
  JOIN competition.entries entry
    ON entry.season_id = roster.season_id
   AND entry.entry_id = roster.entry_id
  WHERE COALESCE(entry.started_event, 1) <= candidate.event_id
), expected_entries AS (
  SELECT
    eligible.tournament_id,
    eligible.season_id,
    eligible.event_id,
    count(*)::integer AS total_entries
  FROM eligible_entries eligible
  GROUP BY eligible.tournament_id, eligible.season_id, eligible.event_id
), valid_entry_events AS (
  SELECT
    eligible.tournament_id,
    eligible.season_id,
    eligible.event_id,
    eligible.entry_id
  FROM eligible_entries eligible
  JOIN competition.entry_event_picks pick
    ON pick.season_id = eligible.season_id
   AND pick.entry_id = eligible.entry_id
   AND pick.event_id = eligible.event_id
  GROUP BY
    eligible.tournament_id,
    eligible.season_id,
    eligible.event_id,
    eligible.entry_id
  HAVING count(*) = 15
     AND min(pick.position) = 1
     AND max(pick.position) = 15
     AND count(*) FILTER (WHERE pick.is_captain) = 1
     AND count(*) FILTER (WHERE pick.is_vice_captain) = 1
), complete_scopes AS (
  SELECT
    expected.tournament_id,
    expected.season_id,
    expected.event_id,
    expected.total_entries
  FROM expected_entries expected
  LEFT JOIN valid_entry_events valid
    ON valid.tournament_id = expected.tournament_id
   AND valid.season_id = expected.season_id
   AND valid.event_id = expected.event_id
  GROUP BY
    expected.tournament_id,
    expected.season_id,
    expected.event_id,
    expected.total_entries
  HAVING expected.total_entries > 0
     AND count(valid.entry_id) = expected.total_entries
), pick_aggregates AS (
  SELECT
    eligible.tournament_id,
    pick.season_id,
    pick.event_id,
    pick.entry_id,
    count(*)::integer AS pick_count,
    sum(pick.multiplier * COALESCE(stats.total_points, 0))::integer AS selection_points,
    sum(
      CASE WHEN pick.multiplier = 0 THEN COALESCE(stats.total_points, 0) ELSE 0 END
    )::integer AS calculated_bench_points,
    sum(
      CASE
        WHEN player.element_type = 1
          THEN pick.multiplier * COALESCE(stats.total_points, 0)
        ELSE 0
      END
    )::integer AS goalkeeper_points,
    sum(
      CASE
        WHEN player.element_type = 2
          THEN pick.multiplier * COALESCE(stats.total_points, 0)
        ELSE 0
      END
    )::integer AS defender_points,
    sum(
      CASE
        WHEN player.element_type = 3
          THEN pick.multiplier * COALESCE(stats.total_points, 0)
        ELSE 0
      END
    )::integer AS midfielder_points,
    sum(
      CASE
        WHEN player.element_type = 4
          THEN pick.multiplier * COALESCE(stats.total_points, 0)
        ELSE 0
      END
    )::integer AS forward_points,
    max(pick.element_id) FILTER (WHERE pick.is_captain) AS captain_element_id,
    max(pick.element_id) FILTER (WHERE pick.is_vice_captain) AS vice_captain_element_id
  FROM eligible_entries eligible
  JOIN competition.entry_event_picks pick
    ON pick.season_id = eligible.season_id
   AND pick.entry_id = eligible.entry_id
   AND pick.event_id = eligible.event_id
  JOIN fpl.players player
    ON player.season_id = pick.season_id
   AND player.element_id = pick.element_id
  LEFT JOIN fpl.player_gameweek_stats stats
    ON stats.season_id = pick.season_id
   AND stats.event_id = pick.event_id
   AND stats.element_id = pick.element_id
  GROUP BY eligible.tournament_id, pick.season_id, pick.event_id, pick.entry_id
), transfer_aggregates AS (
  SELECT
    eligible.tournament_id,
    transfer.season_id,
    transfer.event_id,
    transfer.entry_id,
    count(*)::integer AS transfer_count
  FROM eligible_entries eligible
  JOIN competition.entry_event_transfers transfer
    ON transfer.season_id = eligible.season_id
   AND transfer.entry_id = eligible.entry_id
   AND transfer.event_id = eligible.event_id
  GROUP BY
    eligible.tournament_id,
    transfer.season_id,
    transfer.event_id,
    transfer.entry_id
), base AS (
  SELECT
    eligible.tournament_id,
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
    COALESCE(transfer.transfer_count, 0) AS transfer_row_count,
    event.live_snapshot_finalized_at AS source_finalized_at
  FROM complete_scopes scope
  JOIN eligible_entries eligible
    ON eligible.tournament_id = scope.tournament_id
   AND eligible.season_id = scope.season_id
   AND eligible.event_id = scope.event_id
  JOIN competition.entry_event_results result
    ON result.season_id = eligible.season_id
   AND result.entry_id = eligible.entry_id
   AND result.event_id = eligible.event_id
   AND result.rich_synced_at IS NOT NULL
  JOIN fpl.events event
    ON event.season_id = result.season_id
   AND event.event_id = result.event_id
   AND event.finished
   AND event.data_checked
   AND event.live_snapshot_finalized_at IS NOT NULL
  JOIN pick_aggregates pick
    ON pick.tournament_id = eligible.tournament_id
   AND pick.season_id = result.season_id
   AND pick.event_id = result.event_id
   AND pick.entry_id = result.entry_id
  LEFT JOIN transfer_aggregates transfer
    ON transfer.tournament_id = eligible.tournament_id
   AND transfer.season_id = result.season_id
   AND transfer.event_id = result.event_id
   AND transfer.entry_id = result.entry_id
)
SELECT
  base.tournament_id,
  base.season_id,
  base.event_id,
  base.entry_id,
  base.total_entries,
  base.event_points,
  base.event_transfers,
  base.event_transfers_cost,
  base.event_net_points,
  base.event_bench_points,
  base.event_auto_sub_points,
  base.event_rank,
  base.event_chip,
  base.played_captain_element_id,
  base.captain_points,
  base.overall_points,
  base.overall_rank,
  base.team_value,
  base.bank,
  base.pick_count,
  base.selection_points,
  base.calculated_bench_points,
  base.goalkeeper_points,
  base.defender_points,
  base.midfielder_points,
  base.forward_points,
  base.captain_element_id,
  base.vice_captain_element_id,
  base.transfer_row_count,
  base.source_finalized_at,
  rank() OVER (
    PARTITION BY base.tournament_id, base.event_id
    ORDER BY base.event_net_points DESC, base.entry_id
  ) AS tournament_event_rank,
  sum(base.event_net_points) OVER (
    PARTITION BY base.tournament_id, base.entry_id
    ORDER BY base.event_id
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  )::integer AS cumulative_net_points,
  sum(base.event_transfers) OVER (
    PARTITION BY base.tournament_id, base.entry_id
    ORDER BY base.event_id
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  )::integer AS cumulative_transfers,
  sum(base.event_transfers_cost) OVER (
    PARTITION BY base.tournament_id, base.entry_id
    ORDER BY base.event_id
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  )::integer AS cumulative_transfer_cost,
  sum(COALESCE(base.event_bench_points, 0)) OVER (
    PARTITION BY base.tournament_id, base.entry_id
    ORDER BY base.event_id
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  )::integer AS cumulative_bench_points,
  sum(COALESCE(base.event_auto_sub_points, 0)) OVER (
    PARTITION BY base.tournament_id, base.entry_id
    ORDER BY base.event_id
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  )::integer AS cumulative_auto_sub_points,
  sum(COALESCE(base.captain_points, 0)) OVER (
    PARTITION BY base.tournament_id, base.entry_id
    ORDER BY base.event_id
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  )::integer AS cumulative_captain_points
FROM base;

ALTER MATERIALIZED VIEW reporting.tournament_entry_event_summaries
  OWNER TO letletme_data_owner;

CREATE INDEX tournament_entry_event_summaries_entry_idx
  ON reporting.tournament_entry_event_summaries (tournament_id, entry_id, event_id);

CREATE UNIQUE INDEX tournament_entry_event_summaries_grain_idx
  ON reporting.tournament_entry_event_summaries (tournament_id, event_id, entry_id);

CREATE INDEX tournament_entry_event_summaries_rank_idx
  ON reporting.tournament_entry_event_summaries (
    tournament_id,
    event_id,
    tournament_event_rank
  );

REVOKE ALL ON TABLE reporting.tournament_entry_event_summaries FROM PUBLIC;
GRANT SELECT ON TABLE reporting.tournament_entry_event_summaries TO letletme_graphql_reader;
GRANT SELECT ON TABLE reporting.tournament_entry_event_summaries TO letletme_data_writer;
