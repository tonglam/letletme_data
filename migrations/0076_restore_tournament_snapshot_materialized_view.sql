-- Restore the tournament-level snapshot required by the current runtime.
--
-- Migration 0071 removed this read model from an earlier Understat/FPL
-- deployment lineage. The application still refreshes and reads the model, so
-- recreate the canonical 0041 shape after that historical tail. Keep this as
-- a new migration: 0071 is already applied in production and must remain
-- immutable.

DROP MATERIALIZED VIEW IF EXISTS public.mv_tournament_snapshot;

CREATE MATERIALIZED VIEW public.mv_tournament_snapshot AS
WITH tournament_events AS (
  SELECT mv.tournament_id, mv.event_id
  FROM public.mv_tournament_event_snapshot mv
  UNION ALL
  SELECT battle.tournament_id, battle.event_id
  FROM public.tournament_battle_group_results battle
  WHERE battle.home_match_points IS NOT NULL
    AND battle.away_match_points IS NOT NULL
  UNION ALL
  SELECT knockout.tournament_id, knockout.event_id
  FROM public.tournament_knockout_results knockout
  WHERE knockout.home_net_points IS NOT NULL
    AND knockout.away_net_points IS NOT NULL
), latest_event AS (
  SELECT activity.tournament_id, max(activity.event_id) AS latest_event_id
  FROM tournament_events activity
  GROUP BY activity.tournament_id
), latest_snapshot_event AS (
  SELECT snapshot.tournament_id, max(snapshot.event_id) AS latest_event_id
  FROM public.mv_tournament_event_snapshot snapshot
  GROUP BY snapshot.tournament_id
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
  JOIN latest_snapshot_event le
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
WHERE ti.standings_ready_at IS NOT NULL
GROUP BY ti.id, ti.name, ti.league_id, ti.league_type, le.latest_event_id, mc.total_entries;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_ts_pk
  ON public.mv_tournament_snapshot (tournament_id);

REVOKE ALL ON TABLE public.mv_tournament_snapshot FROM PUBLIC;

DO $$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE public.mv_tournament_snapshot FROM %I',
        client_role
      );
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON TABLE public.mv_tournament_snapshot TO service_role;
  END IF;
END $$;
