-- Recompute durable points-race group ranks using the same finalized-event
-- cumulative totals and competition-ranking convention as My Tournament Review
-- V2. Older writers assigned the last position to a tied score/rank key; the
-- repair is intentionally idempotent and updates only rows whose rank changes.
WITH finalized_points AS (
  SELECT points.source_result_id,
         points.season_id,
         points.tournament_id,
         points.event_id,
         points.group_id,
         points.entry_id,
         points.event_net_points,
         current_result.overall_rank,
         SUM(points.event_net_points) OVER (
           PARTITION BY points.season_id, points.tournament_id, points.group_id, points.entry_id
           ORDER BY points.event_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS cumulative_net_points
  FROM competition.tournament_points_group_results points
  JOIN competition.tournaments tournament
    ON tournament.season_id = points.season_id
   AND tournament.tournament_id = points.tournament_id
  JOIN competition.tournament_entries roster
    ON roster.season_id = points.season_id
   AND roster.tournament_id = points.tournament_id
   AND roster.entry_id = points.entry_id
  JOIN competition.entries entry
    ON entry.season_id = points.season_id
   AND entry.entry_id = points.entry_id
  JOIN fpl.events event
    ON event.season_id = points.season_id
   AND event.event_id = points.event_id
  LEFT JOIN competition.entry_event_results current_result
    ON current_result.season_id = points.season_id
   AND current_result.entry_id = points.entry_id
   AND current_result.event_id = points.event_id
  WHERE tournament.group_mode = 'points_races'
    AND tournament.group_started_event_id IS NOT NULL
    AND tournament.group_ended_event_id IS NOT NULL
    AND points.event_id >= GREATEST(
      tournament.group_started_event_id,
      COALESCE(entry.started_event, tournament.group_started_event_id)
    )
    AND points.event_id <= tournament.group_ended_event_id
    AND event.finished = true
    AND event.data_checked = true
    AND event.data_checked_at IS NOT NULL
    AND points.event_net_points IS NOT NULL
), ranked AS (
  SELECT source_result_id,
         season_id,
         tournament_id,
         event_id,
         RANK() OVER (
           PARTITION BY season_id, tournament_id, event_id, group_id
           ORDER BY cumulative_net_points DESC, overall_rank NULLS LAST
         )::integer AS repaired_rank
  FROM finalized_points
)
UPDATE competition.tournament_points_group_results points
SET event_group_rank = ranked.repaired_rank,
    updated_at = clock_timestamp()
FROM ranked
WHERE points.source_result_id = ranked.source_result_id
  AND points.season_id = ranked.season_id
  AND points.tournament_id = ranked.tournament_id
  AND points.event_id = ranked.event_id
  AND points.event_group_rank IS DISTINCT FROM ranked.repaired_rank;
