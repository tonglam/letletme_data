-- Correct the reporting denominator for managers who joined FPL after a tournament's
-- historical event. This file sorts before approval-gated 0091 legacy cleanup.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL ROLE letletme_data_owner;

DROP MATERIALIZED VIEW reporting.tournament_selection_stats;

CREATE MATERIALIZED VIEW reporting.tournament_selection_stats AS
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
    roster.entry_id,
    entry.transfers_synced_through_event_id
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
    count(*)::integer AS total_entries,
    count(*) FILTER (
      WHERE eligible.transfers_synced_through_event_id >= eligible.event_id
    )::integer AS transfer_checkpoint_entries
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
    expected.total_entries,
    expected.transfer_checkpoint_entries
  FROM expected_entries expected
  LEFT JOIN valid_entry_events valid
    ON valid.tournament_id = expected.tournament_id
   AND valid.season_id = expected.season_id
   AND valid.event_id = expected.event_id
  GROUP BY
    expected.tournament_id,
    expected.season_id,
    expected.event_id,
    expected.total_entries,
    expected.transfer_checkpoint_entries
  HAVING expected.total_entries > 0
     AND expected.transfer_checkpoint_entries = expected.total_entries
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
  JOIN eligible_entries eligible
    ON eligible.tournament_id = scope.tournament_id
   AND eligible.season_id = scope.season_id
   AND eligible.event_id = scope.event_id
  JOIN competition.entry_event_picks pick
    ON pick.season_id = eligible.season_id
   AND pick.entry_id = eligible.entry_id
   AND pick.event_id = eligible.event_id
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
  GROUP BY
    pick.tournament_id,
    pick.season_id,
    pick.event_id,
    pick.total_entries,
    pick.element_id
), transfer_stats AS (
  SELECT
    scope.tournament_id,
    scope.season_id,
    scope.event_id,
    element.element_id,
    count(*) FILTER (WHERE element.direction = 'in')::integer AS transfer_in_count,
    count(*) FILTER (WHERE element.direction = 'out')::integer AS transfer_out_count
  FROM complete_scopes scope
  JOIN eligible_entries eligible
    ON eligible.tournament_id = scope.tournament_id
   AND eligible.season_id = scope.season_id
   AND eligible.event_id = scope.event_id
  JOIN competition.entry_event_transfers transfer
    ON transfer.season_id = eligible.season_id
   AND transfer.entry_id = eligible.entry_id
   AND transfer.event_id = eligible.event_id
  CROSS JOIN LATERAL (
    VALUES
      (transfer.element_in_id, 'in'::text),
      (transfer.element_out_id, 'out'::text)
  ) AS element(element_id, direction)
  WHERE element.element_id IS NOT NULL
  GROUP BY scope.tournament_id, scope.season_id, scope.event_id, element.element_id
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

CREATE UNIQUE INDEX tournament_selection_stats_grain_idx
  ON reporting.tournament_selection_stats (tournament_id, event_id, element_id);
CREATE INDEX tournament_selection_stats_selected_idx
  ON reporting.tournament_selection_stats (tournament_id, event_id, selected_count DESC, element_id);
CREATE INDEX tournament_selection_stats_captain_idx
  ON reporting.tournament_selection_stats (tournament_id, event_id, captain_count DESC, element_id);
CREATE INDEX tournament_selection_stats_transfer_in_idx
  ON reporting.tournament_selection_stats (tournament_id, event_id, transfer_in_count DESC, element_id);

REFRESH MATERIALIZED VIEW reporting.tournament_selection_stats;
ANALYZE reporting.tournament_selection_stats;

REVOKE ALL ON reporting.tournament_selection_stats FROM PUBLIC;
GRANT SELECT ON reporting.tournament_selection_stats TO letletme_graphql_reader;

RESET ROLE;
