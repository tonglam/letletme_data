CREATE OR REPLACE VIEW public.v_tournament_selection_stats AS
WITH pick_data AS (
  SELECT
    te.tournament_id,
    eer.event_id,
    (pick.item ->> 'element')::int AS element_id,
    COUNT(*) AS pick_count,
    COUNT(*) FILTER (WHERE (pick.item ->> 'is_captain')::boolean) AS captain_count,
    COUNT(*) FILTER (WHERE (pick.item ->> 'is_vice_captain')::boolean) AS vice_captain_count
  FROM tournament_entries te
  JOIN entry_event_results eer
    ON eer.entry_id = te.entry_id
  CROSS JOIN LATERAL jsonb_array_elements(eer.event_picks) AS pick(item)
  GROUP BY te.tournament_id, eer.event_id, (pick.item ->> 'element')::int
),
transfer_in AS (
  SELECT
    te.tournament_id,
    eet.event_id,
    eet.element_in_id AS element_id,
    COUNT(*) AS transfer_in_count
  FROM tournament_entries te
  JOIN entry_event_transfers eet
    ON eet.entry_id = te.entry_id
  WHERE eet.element_in_id IS NOT NULL
  GROUP BY te.tournament_id, eet.event_id, eet.element_in_id
),
transfer_out AS (
  SELECT
    te.tournament_id,
    eet.event_id,
    eet.element_out_id AS element_id,
    COUNT(*) AS transfer_out_count
  FROM tournament_entries te
  JOIN entry_event_transfers eet
    ON eet.entry_id = te.entry_id
  WHERE eet.element_out_id IS NOT NULL
  GROUP BY te.tournament_id, eet.event_id, eet.element_out_id
),
entry_counts AS (
  SELECT
    te.tournament_id,
    eer.event_id,
    COUNT(DISTINCT te.entry_id)::int AS total_entries
  FROM tournament_entries te
  JOIN entry_event_results eer
    ON eer.entry_id = te.entry_id
  GROUP BY te.tournament_id, eer.event_id
)
SELECT
  COALESCE(pd.tournament_id, ti.tournament_id, to2.tournament_id) AS tournament_id,
  COALESCE(pd.event_id, ti.event_id, to2.event_id) AS event_id,
  ec.total_entries,
  COALESCE(pd.element_id, ti.element_id, to2.element_id) AS element_id,
  COALESCE(pd.pick_count, 0)::int AS pick_count,
  COALESCE(pd.captain_count, 0)::int AS captain_count,
  COALESCE(pd.vice_captain_count, 0)::int AS vice_captain_count,
  COALESCE(ti.transfer_in_count, 0)::int AS transfer_in_count,
  COALESCE(to2.transfer_out_count, 0)::int AS transfer_out_count
FROM pick_data pd
FULL OUTER JOIN transfer_in ti
  ON ti.tournament_id = pd.tournament_id
  AND ti.event_id = pd.event_id
  AND ti.element_id = pd.element_id
FULL OUTER JOIN transfer_out to2
  ON to2.tournament_id = COALESCE(pd.tournament_id, ti.tournament_id)
  AND to2.event_id = COALESCE(pd.event_id, ti.event_id)
  AND to2.element_id = COALESCE(pd.element_id, ti.element_id)
JOIN entry_counts ec
  ON ec.tournament_id = COALESCE(pd.tournament_id, ti.tournament_id, to2.tournament_id)
  AND ec.event_id = COALESCE(pd.event_id, ti.event_id, to2.event_id);

ALTER VIEW public.v_tournament_selection_stats
  SET (security_invoker = true);
