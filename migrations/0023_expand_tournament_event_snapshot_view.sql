CREATE OR REPLACE VIEW public.v_tournament_event_snapshot AS
WITH snapshot_base AS (
  SELECT
    tpr.tournament_id,
    tpr.event_id,
    tpr.entry_id,
    tpr.event_group_rank AS tournament_overall_rank,
    ler.overall_rank,
    ler.team_value,
    COALESCE(tpr.cum_transfers_num, 0) AS cum_transfers_num,
    COALESCE(tpr.cum_total_costs, 0) AS cum_total_costs,
    COALESCE(tpr.cum_total_bench_points, 0) AS cum_total_bench_points,
    COALESCE(tpr.cum_auto_sub_points, 0) AS cum_auto_sub_points,
    captain_agg.cum_total_captain_points,
    captain_agg.highese_captian_points,
    captain_agg.average_catain_points,
    CASE
      WHEN captain_agg.cum_total_event_points = 0 THEN 0::numeric
      ELSE ROUND(
        (captain_agg.cum_total_captain_points::numeric / captain_agg.cum_total_event_points::numeric)
        * 100,
        2
      )
    END AS captain_points_percentage,
    captain_mode.most_selected_captain,
    position_agg.cum_total_gk_points,
    position_agg.cum_total_def_points,
    position_agg.cum_total_mid_points,
    position_agg.cum_total_fwd_points
  FROM tournament_points_group_results tpr
  JOIN tournament_infos ti ON ti.id = tpr.tournament_id
  LEFT JOIN league_event_results ler
    ON ler.league_id = ti.league_id
    AND ler.league_type::text = ti.league_type::text
    AND ler.event_id = tpr.event_id
    AND ler.entry_id = tpr.entry_id
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(SUM(COALESCE(eer.event_captain_points, 0)), 0)::int AS cum_total_captain_points,
      COALESCE(MAX(eer.event_captain_points), 0)::int AS highese_captian_points,
      COALESCE(ROUND(AVG(eer.event_captain_points::numeric), 2), 0::numeric) AS average_catain_points,
      COALESCE(SUM(COALESCE(eer.event_points, 0)), 0)::int AS cum_total_event_points
    FROM entry_event_results eer
    WHERE eer.entry_id = tpr.entry_id
      AND eer.event_id BETWEEN COALESCE(ti.group_started_event_id, 1) AND tpr.event_id
  ) captain_agg ON TRUE
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(
        SUM(
          CASE
            WHEN p.type = 1 THEN COALESCE(el.total_points, 0)
            ELSE 0
          END
        ),
        0
      )::int AS cum_total_gk_points,
      COALESCE(
        SUM(
          CASE
            WHEN p.type = 2 THEN COALESCE(el.total_points, 0)
            ELSE 0
          END
        ),
        0
      )::int AS cum_total_def_points,
      COALESCE(
        SUM(
          CASE
            WHEN p.type = 3 THEN COALESCE(el.total_points, 0)
            ELSE 0
          END
        ),
        0
      )::int AS cum_total_mid_points,
      COALESCE(
        SUM(
          CASE
            WHEN p.type = 4 THEN COALESCE(el.total_points, 0)
            ELSE 0
          END
        ),
        0
      )::int AS cum_total_fwd_points
    FROM entry_event_results eer_pos
    JOIN LATERAL jsonb_array_elements(COALESCE(eer_pos.event_picks, '[]'::jsonb)) pick(item) ON TRUE
    JOIN players p
      ON p.id = (pick.item ->> 'element')::int
    LEFT JOIN event_lives el
      ON el.event_id = eer_pos.event_id
      AND el.element_id = p.id
    WHERE eer_pos.entry_id = tpr.entry_id
      AND eer_pos.event_id BETWEEN COALESCE(ti.group_started_event_id, 1) AND tpr.event_id
  ) position_agg ON TRUE
  LEFT JOIN LATERAL (
    SELECT
      eer2.event_played_captain AS most_selected_captain
    FROM tournament_entries te2
    JOIN entry_event_results eer2
      ON eer2.entry_id = te2.entry_id
      AND eer2.event_id = tpr.event_id
    WHERE te2.tournament_id = tpr.tournament_id
      AND eer2.event_played_captain IS NOT NULL
    GROUP BY eer2.event_played_captain
    ORDER BY COUNT(*) DESC, eer2.event_played_captain ASC
    LIMIT 1
  ) captain_mode ON TRUE
)
SELECT
  sb.tournament_id,
  sb.event_id,
  sb.entry_id,
  sb.tournament_overall_rank,
  sb.overall_rank,
  sb.team_value,
  sb.cum_transfers_num,
  sb.cum_total_costs,
  sb.cum_total_bench_points,
  sb.cum_auto_sub_points,
  CASE
    WHEN sb.team_value IS NULL THEN NULL::bigint
    ELSE RANK() OVER (
      PARTITION BY sb.tournament_id, sb.event_id
      ORDER BY sb.team_value DESC NULLS LAST
    )
  END AS tournament_team_value_rank,
  RANK() OVER (
    PARTITION BY sb.tournament_id, sb.event_id
    ORDER BY sb.cum_transfers_num
  ) AS tournament_transfers_rank,
  RANK() OVER (
    PARTITION BY sb.tournament_id, sb.event_id
    ORDER BY sb.cum_total_costs
  ) AS tournament_costs_rank,
  RANK() OVER (
    PARTITION BY sb.tournament_id, sb.event_id
    ORDER BY sb.cum_total_bench_points DESC
  ) AS tournament_bench_points_rank,
  RANK() OVER (
    PARTITION BY sb.tournament_id, sb.event_id
    ORDER BY sb.cum_auto_sub_points DESC
  ) AS tournament_auto_sub_rank,
  sb.cum_total_captain_points,
  sb.highese_captian_points,
  sb.average_catain_points,
  sb.captain_points_percentage,
  RANK() OVER (
    PARTITION BY sb.tournament_id, sb.event_id
    ORDER BY sb.cum_total_captain_points DESC
  ) AS tournament_captain_points_rank,
  RANK() OVER (
    PARTITION BY sb.tournament_id, sb.event_id
    ORDER BY sb.captain_points_percentage DESC
  ) AS tournament_captain_points_percentage_rank,
  sb.most_selected_captain,
  sb.cum_total_gk_points,
  sb.cum_total_def_points,
  sb.cum_total_mid_points,
  sb.cum_total_fwd_points
FROM snapshot_base sb;

ALTER VIEW public.v_tournament_event_snapshot
SET (security_invoker = true);
