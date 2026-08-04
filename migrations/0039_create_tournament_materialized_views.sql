-- Add group_mode to mv_tournament_event_snapshot so that API queries can
-- validate tournament type directly from the materialized view, eliminating
-- a separate round-trip to tournament_infos.
--
-- Changes:
--   1) snapshot_base CTE selects ti.group_mode
--   2) Final SELECT exposes sb.group_mode
--   3) mv_tournament_snapshot current_snapshot CTE carries v.group_mode
--
-- Fresh Data installs historically omitted both materialized views even
-- though runtime refreshes and GraphQL reads depend on them. Existing
-- environments may have the earlier definition without group_mode. Replace
-- both views in dependency order inside this migration transaction so fresh
-- and upgraded databases receive the same query shape.

DROP MATERIALIZED VIEW IF EXISTS public.mv_tournament_snapshot;
DROP MATERIALIZED VIEW IF EXISTS public.mv_tournament_event_snapshot;

-- =============================================================================
-- 1. mv_tournament_event_snapshot
-- =============================================================================

CREATE MATERIALIZED VIEW public.mv_tournament_event_snapshot AS
WITH snapshot_base AS (
  SELECT
    tpr.tournament_id,
    tpr.event_id,
    tpr.entry_id,
    ti.group_mode AS group_mode,
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
      ELSE round(captain_agg.cum_total_captain_points::numeric / captain_agg.cum_total_event_points::numeric * 100::numeric, 2)
    END AS captain_points_percentage,
    captain_mode.most_selected_captain,
    position_agg.cum_total_gk_points,
    position_agg.cum_total_def_points,
    position_agg.cum_total_mid_points,
    position_agg.cum_total_fwd_points
  FROM public.tournament_points_group_results tpr
  JOIN public.tournament_infos ti
    ON ti.id = tpr.tournament_id
  LEFT JOIN public.league_event_results ler
    ON ler.league_id = ti.league_id
    AND ler.league_type::text = ti.league_type::text
    AND ler.event_id = tpr.event_id
    AND ler.entry_id = tpr.entry_id
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(sum(COALESCE(eer.event_captain_points, 0)), 0::bigint)::integer AS cum_total_captain_points,
      COALESCE(max(eer.event_captain_points), 0) AS highese_captian_points,
      COALESCE(round(avg(eer.event_captain_points::numeric), 2), 0::numeric) AS average_catain_points,
      COALESCE(sum(COALESCE(eer.event_points, 0)), 0::bigint)::integer AS cum_total_event_points
    FROM public.entry_event_results eer
    WHERE eer.entry_id = tpr.entry_id
      AND eer.event_id >= COALESCE(ti.group_started_event_id, 1)
      AND eer.event_id <= tpr.event_id
  ) captain_agg ON true
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(sum(CASE WHEN p.type = 1 THEN COALESCE(el.total_points, 0) ELSE 0 END), 0::bigint)::integer AS cum_total_gk_points,
      COALESCE(sum(CASE WHEN p.type = 2 THEN COALESCE(el.total_points, 0) ELSE 0 END), 0::bigint)::integer AS cum_total_def_points,
      COALESCE(sum(CASE WHEN p.type = 3 THEN COALESCE(el.total_points, 0) ELSE 0 END), 0::bigint)::integer AS cum_total_mid_points,
      COALESCE(sum(CASE WHEN p.type = 4 THEN COALESCE(el.total_points, 0) ELSE 0 END), 0::bigint)::integer AS cum_total_fwd_points
    FROM public.entry_event_results eer_pos
    JOIN LATERAL jsonb_array_elements(COALESCE(eer_pos.event_picks, '[]'::jsonb)) pick(item) ON true
    JOIN public.players p ON p.id = ((pick.item ->> 'element'::text)::integer)
    LEFT JOIN public.event_lives el ON el.event_id = eer_pos.event_id AND el.element_id = p.id
    WHERE eer_pos.entry_id = tpr.entry_id
      AND eer_pos.event_id >= COALESCE(ti.group_started_event_id, 1)
      AND eer_pos.event_id <= tpr.event_id
  ) position_agg ON true
  LEFT JOIN LATERAL (
    SELECT eer2.event_played_captain AS most_selected_captain
    FROM public.tournament_entries te2
    JOIN public.entry_event_results eer2
      ON eer2.entry_id = te2.entry_id AND eer2.event_id = tpr.event_id
    WHERE te2.tournament_id = tpr.tournament_id
      AND eer2.event_played_captain IS NOT NULL
    GROUP BY eer2.event_played_captain
    ORDER BY count(*) DESC, eer2.event_played_captain
    LIMIT 1
  ) captain_mode ON true
)
SELECT
  sb.tournament_id,
  sb.event_id,
  sb.entry_id,
  sb.group_mode,
  sb.tournament_overall_rank,
  sb.overall_rank,
  sb.team_value,
  sb.cum_transfers_num,
  sb.cum_total_costs,
  sb.cum_total_bench_points,
  sb.cum_auto_sub_points,
  CASE
    WHEN sb.team_value IS NULL THEN NULL::bigint
    ELSE rank() OVER (PARTITION BY sb.tournament_id, sb.event_id ORDER BY sb.team_value DESC NULLS LAST)
  END AS tournament_team_value_rank,
  rank() OVER (PARTITION BY sb.tournament_id, sb.event_id ORDER BY sb.cum_transfers_num) AS tournament_transfers_rank,
  rank() OVER (PARTITION BY sb.tournament_id, sb.event_id ORDER BY sb.cum_total_costs) AS tournament_costs_rank,
  rank() OVER (PARTITION BY sb.tournament_id, sb.event_id ORDER BY sb.cum_total_bench_points DESC) AS tournament_bench_points_rank,
  rank() OVER (PARTITION BY sb.tournament_id, sb.event_id ORDER BY sb.cum_auto_sub_points DESC) AS tournament_auto_sub_rank,
  sb.cum_total_captain_points,
  sb.highese_captian_points,
  sb.average_catain_points,
  sb.captain_points_percentage,
  rank() OVER (PARTITION BY sb.tournament_id, sb.event_id ORDER BY sb.cum_total_captain_points DESC) AS tournament_captain_points_rank,
  rank() OVER (PARTITION BY sb.tournament_id, sb.event_id ORDER BY sb.captain_points_percentage DESC) AS tournament_captain_points_percentage_rank,
  sb.most_selected_captain,
  sb.cum_total_gk_points,
  sb.cum_total_def_points,
  sb.cum_total_mid_points,
  sb.cum_total_fwd_points
FROM snapshot_base sb;

-- Unique index required for REFRESH MATERIALIZED VIEW CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_tes_pk
  ON public.mv_tournament_event_snapshot (tournament_id, event_id, entry_id);

-- Query-pattern indexes
CREATE INDEX IF NOT EXISTS idx_mv_tes_event_lookup
  ON public.mv_tournament_event_snapshot (tournament_id, event_id);


-- =============================================================================
-- 2. mv_tournament_snapshot
-- =============================================================================

CREATE MATERIALIZED VIEW public.mv_tournament_snapshot AS
WITH tournament_events AS (
  SELECT mv.tournament_id, mv.event_id
  FROM public.mv_tournament_event_snapshot mv
  UNION ALL
  SELECT battle.tournament_id, battle.event_id
  FROM public.tournament_battle_group_results battle
  UNION ALL
  SELECT knockout.tournament_id, knockout.event_id
  FROM public.tournament_knockout_results knockout
), latest_event AS (
  SELECT activity.tournament_id, max(activity.event_id) AS latest_event_id
  FROM tournament_events activity
  GROUP BY activity.tournament_id
), current_snapshot AS (
  SELECT
    v.tournament_id, v.event_id, v.entry_id,
    v.group_mode,
    v.tournament_overall_rank, v.overall_rank, v.team_value,
    v.cum_transfers_num, v.cum_total_costs, v.cum_total_bench_points, v.cum_auto_sub_points,
    v.tournament_team_value_rank, v.tournament_transfers_rank, v.tournament_costs_rank,
    v.tournament_bench_points_rank, v.tournament_auto_sub_rank,
    v.cum_total_captain_points, v.highese_captian_points, v.average_catain_points,
    v.captain_points_percentage, v.tournament_captain_points_rank,
    v.tournament_captain_points_percentage_rank, v.most_selected_captain,
    v.cum_total_gk_points, v.cum_total_def_points, v.cum_total_mid_points, v.cum_total_fwd_points
  FROM public.mv_tournament_event_snapshot v
  JOIN latest_event le
    ON le.tournament_id = v.tournament_id AND le.latest_event_id = v.event_id
), top10_snapshot AS (
  SELECT *
  FROM current_snapshot
  WHERE tournament_overall_rank IS NOT NULL AND tournament_overall_rank <= 10
), membership_counts AS (
  SELECT te.tournament_id, count(*)::integer AS total_entries
  FROM public.tournament_entries te
  GROUP BY te.tournament_id
)
SELECT
  ti.id AS tournament_id,
  ti.name AS tournament_name,
  ti.league_id,
  ti.league_type,
  le.latest_event_id,
  COALESCE(mc.total_entries, 0)::integer AS total_entries,
  count(t10.entry_id)::integer AS top10_entry_count,
  round(avg((t10.cum_total_gk_points + t10.cum_total_def_points + t10.cum_total_mid_points + t10.cum_total_fwd_points)::numeric), 2) AS top10_avg_total_points,
  round(avg(t10.cum_total_captain_points::numeric), 2) AS top10_avg_captain_points,
  round(avg(t10.captain_points_percentage), 2) AS top10_avg_captain_points_percentage,
  round(avg(t10.cum_total_gk_points::numeric), 2) AS top10_avg_gk_points,
  round(avg(t10.cum_total_def_points::numeric), 2) AS top10_avg_def_points,
  round(avg(t10.cum_total_mid_points::numeric), 2) AS top10_avg_mid_points,
  round(avg(t10.cum_total_fwd_points::numeric), 2) AS top10_avg_fwd_points,
  round(avg(t10.team_value::numeric), 2) AS top10_avg_team_value,
  round(avg(t10.overall_rank::numeric), 2) AS top10_avg_overall_rank,
  round(avg(t10.cum_transfers_num::numeric), 2) AS top10_avg_cum_transfer_num,
  round(avg(t10.cum_total_costs::numeric), 2) AS top10_avg_cum_total_cost,
  round(avg(t10.cum_total_bench_points::numeric), 2) AS top10_avg_cum_bench_points,
  round(avg(t10.cum_auto_sub_points::numeric), 2) AS top10_avg_cum_auto_sub_points,
  round(avg((COALESCE(cs.cum_total_gk_points, 0) + COALESCE(cs.cum_total_def_points, 0) + COALESCE(cs.cum_total_mid_points, 0) + COALESCE(cs.cum_total_fwd_points, 0))::numeric), 2) AS all_avg_total_points,
  round(avg(cs.cum_total_captain_points::numeric), 2) AS all_avg_captain_points,
  round(avg(cs.captain_points_percentage), 2) AS all_avg_captain_points_percentage,
  round(avg(cs.cum_total_gk_points::numeric), 2) AS all_avg_gk_points,
  round(avg(cs.cum_total_def_points::numeric), 2) AS all_avg_def_points,
  round(avg(cs.cum_total_mid_points::numeric), 2) AS all_avg_mid_points,
  round(avg(cs.cum_total_fwd_points::numeric), 2) AS all_avg_fwd_points
FROM public.tournament_infos ti
LEFT JOIN latest_event le ON le.tournament_id = ti.id
LEFT JOIN current_snapshot cs ON cs.tournament_id = ti.id
LEFT JOIN top10_snapshot t10 ON t10.tournament_id = ti.id AND t10.entry_id = cs.entry_id
LEFT JOIN membership_counts mc ON mc.tournament_id = ti.id
GROUP BY ti.id, ti.name, ti.league_id, ti.league_type, le.latest_event_id, mc.total_entries;

-- Unique index required for REFRESH MATERIALIZED VIEW CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_ts_pk
  ON public.mv_tournament_snapshot (tournament_id);



-- Materialized views are internal Data/GraphQL objects. Supabase grants and
-- RLS are independent controls; materialized views have no RLS, so deny client
-- roles explicitly and grant only the trusted service role used by GraphQL.
REVOKE ALL ON TABLE public.mv_tournament_event_snapshot FROM PUBLIC;
REVOKE ALL ON TABLE public.mv_tournament_snapshot FROM PUBLIC;

DO $$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE public.mv_tournament_event_snapshot FROM %I',
        client_role
      );
      EXECUTE format(
        'REVOKE ALL ON TABLE public.mv_tournament_snapshot FROM %I',
        client_role
      );
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON TABLE public.mv_tournament_event_snapshot TO service_role;
    GRANT SELECT ON TABLE public.mv_tournament_snapshot TO service_role;
  END IF;
END $$;
