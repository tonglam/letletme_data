CREATE OR REPLACE VIEW public.v_tournament_snapshot AS
WITH latest_event AS (
  SELECT
    tournament_id,
    MAX(event_id)::int AS latest_event_id
  FROM public.v_tournament_event_snapshot
  GROUP BY tournament_id
),
current_snapshot AS (
  SELECT
    v.*
  FROM public.v_tournament_event_snapshot v
  JOIN latest_event le
    ON le.tournament_id = v.tournament_id
   AND le.latest_event_id = v.event_id
),
top10_snapshot AS (
  SELECT
    *
  FROM current_snapshot
  WHERE tournament_overall_rank IS NOT NULL
    AND tournament_overall_rank <= 10
)
SELECT
  ti.id AS tournament_id,
  ti.name AS tournament_name,
  ti.league_id,
  ti.league_type,
  le.latest_event_id,
  COUNT(cs.entry_id)::int AS total_entries,
  COUNT(t10.entry_id)::int AS top10_entry_count,
  ROUND(
    AVG(
      (
        t10.cum_total_gk_points
        + t10.cum_total_def_points
        + t10.cum_total_mid_points
        + t10.cum_total_fwd_points
      )::numeric
    ),
    2
  ) AS top10_avg_total_points,
  ROUND(AVG(t10.cum_total_captain_points::numeric), 2) AS top10_avg_captain_points,
  ROUND(AVG(t10.captain_points_percentage::numeric), 2) AS top10_avg_captain_points_percentage,
  ROUND(AVG(t10.cum_total_gk_points::numeric), 2) AS top10_avg_gk_points,
  ROUND(AVG(t10.cum_total_def_points::numeric), 2) AS top10_avg_def_points,
  ROUND(AVG(t10.cum_total_mid_points::numeric), 2) AS top10_avg_mid_points,
  ROUND(AVG(t10.cum_total_fwd_points::numeric), 2) AS top10_avg_fwd_points,
  ROUND(AVG(t10.team_value::numeric), 2) AS top10_avg_team_value,
  ROUND(AVG(t10.overall_rank::numeric), 2) AS top10_avg_overall_rank,
  ROUND(AVG(t10.cum_transfers_num::numeric), 2) AS top10_avg_cum_transfer_num,
  ROUND(AVG(t10.cum_total_costs::numeric), 2) AS top10_avg_cum_total_cost,
  ROUND(AVG(t10.cum_total_bench_points::numeric), 2) AS top10_avg_cum_bench_points,
  ROUND(AVG(t10.cum_auto_sub_points::numeric), 2) AS top10_avg_cum_auto_sub_points,
  ROUND(
    AVG(
      (
        COALESCE(cs.cum_total_gk_points, 0)
        + COALESCE(cs.cum_total_def_points, 0)
        + COALESCE(cs.cum_total_mid_points, 0)
        + COALESCE(cs.cum_total_fwd_points, 0)
      )::numeric
    ),
    2
  ) AS all_avg_total_points,
  ROUND(AVG(cs.cum_total_captain_points::numeric), 2) AS all_avg_captain_points,
  ROUND(AVG(cs.captain_points_percentage::numeric), 2) AS all_avg_captain_points_percentage,
  ROUND(AVG(cs.cum_total_gk_points::numeric), 2) AS all_avg_gk_points,
  ROUND(AVG(cs.cum_total_def_points::numeric), 2) AS all_avg_def_points,
  ROUND(AVG(cs.cum_total_mid_points::numeric), 2) AS all_avg_mid_points,
  ROUND(AVG(cs.cum_total_fwd_points::numeric), 2) AS all_avg_fwd_points
FROM public.tournament_infos ti
JOIN latest_event le
  ON le.tournament_id = ti.id
JOIN current_snapshot cs
  ON cs.tournament_id = ti.id
LEFT JOIN top10_snapshot t10
  ON t10.tournament_id = ti.id
 AND t10.entry_id = cs.entry_id
GROUP BY
  ti.id,
  ti.name,
  ti.league_id,
  ti.league_type,
  le.latest_event_id;

ALTER VIEW public.v_tournament_snapshot
SET (security_invoker = true);
