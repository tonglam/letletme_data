-- Keep tournament read models empty until core standings are published and
-- make positional aggregates depend on the same season-owned final live
-- evidence used by the terminal live readers. This migration replaces the
-- already-applied materialized-view definitions; the earlier migrations stay
-- immutable.

-- The legacy snapshot views are replaced below and, after the first run,
-- depend on these materialized views. Drop them first so a migration replay
-- (or a repaired deployment) can rebuild the objects in the same order.
DROP VIEW IF EXISTS public.v_tournament_snapshot;
DROP VIEW IF EXISTS public.v_tournament_event_snapshot;
DROP MATERIALIZED VIEW IF EXISTS public.mv_tournament_snapshot;
DROP MATERIALIZED VIEW IF EXISTS public.mv_tournament_event_snapshot;

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
    AND ti.standings_ready_at IS NOT NULL
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
    JOIN public.events live_event
      ON live_event.id = eer_pos.event_id
      AND live_event.finished = true
      AND live_event.data_checked = true
      AND live_event.deadline_time IS NOT NULL
      AND live_event.live_snapshot_finalized_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.events season_start
        WHERE season_start.id = 1
          AND season_start.deadline_time IS NOT NULL
          -- Event IDs repeat every season. GW1 is the season anchor; do not
          -- derive a new season from the calendar year of every deadline
          -- (late-season fixtures can cross New Year's Day).
          AND live_event.deadline_time >= season_start.deadline_time
          AND live_event.deadline_time < season_start.deadline_time + interval '1 year'
      )
    LEFT JOIN public.event_lives el
      ON el.event_id = eer_pos.event_id
      AND el.element_id = p.id
      AND COALESCE(el.updated_at, el.created_at) >= live_event.live_snapshot_finalized_at
      AND COALESCE(el.updated_at, el.created_at) >= live_event.deadline_time
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_tes_pk
  ON public.mv_tournament_event_snapshot (tournament_id, event_id, entry_id);
CREATE INDEX IF NOT EXISTS idx_mv_tes_event_lookup
  ON public.mv_tournament_event_snapshot (tournament_id, event_id);

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

-- Keep the legacy view contracts safe as well. They are still granted to the
-- trusted GraphQL service and may be used by older readers, so readiness must
-- be enforced at the view boundary rather than relying on cache invalidation.
CREATE OR REPLACE VIEW public.v_tournament_event_snapshot AS
SELECT
  snapshot.tournament_id,
  snapshot.event_id,
  snapshot.entry_id,
  snapshot.tournament_overall_rank,
  snapshot.overall_rank,
  snapshot.team_value,
  snapshot.cum_transfers_num,
  snapshot.cum_total_costs,
  snapshot.cum_total_bench_points,
  snapshot.cum_auto_sub_points,
  snapshot.tournament_team_value_rank,
  snapshot.tournament_transfers_rank,
  snapshot.tournament_costs_rank,
  snapshot.tournament_bench_points_rank,
  snapshot.tournament_auto_sub_rank,
  snapshot.cum_total_captain_points,
  snapshot.highese_captian_points,
  snapshot.average_catain_points,
  snapshot.captain_points_percentage,
  snapshot.tournament_captain_points_rank,
  snapshot.tournament_captain_points_percentage_rank,
  snapshot.most_selected_captain,
  snapshot.cum_total_gk_points,
  snapshot.cum_total_def_points,
  snapshot.cum_total_mid_points,
  snapshot.cum_total_fwd_points
FROM public.mv_tournament_event_snapshot snapshot
JOIN public.tournament_infos tournament
  ON tournament.id = snapshot.tournament_id
  AND tournament.standings_ready_at IS NOT NULL;

ALTER VIEW public.v_tournament_event_snapshot SET (security_invoker = true);

CREATE OR REPLACE VIEW public.v_tournament_snapshot AS
SELECT
  snapshot.tournament_id,
  snapshot.tournament_name,
  snapshot.league_id,
  snapshot.league_type,
  snapshot.latest_event_id,
  snapshot.total_entries,
  snapshot.top10_entry_count,
  snapshot.top10_avg_total_points,
  snapshot.top10_avg_captain_points,
  snapshot.top10_avg_captain_points_percentage,
  snapshot.top10_avg_gk_points,
  snapshot.top10_avg_def_points,
  snapshot.top10_avg_mid_points,
  snapshot.top10_avg_fwd_points,
  snapshot.top10_avg_team_value,
  snapshot.top10_avg_overall_rank,
  snapshot.top10_avg_cum_transfer_num,
  snapshot.top10_avg_cum_total_cost,
  snapshot.top10_avg_cum_bench_points,
  snapshot.top10_avg_cum_auto_sub_points,
  snapshot.all_avg_total_points,
  snapshot.all_avg_captain_points,
  snapshot.all_avg_captain_points_percentage,
  snapshot.all_avg_gk_points,
  snapshot.all_avg_def_points,
  snapshot.all_avg_mid_points,
  snapshot.all_avg_fwd_points
FROM public.mv_tournament_snapshot snapshot
JOIN public.tournament_infos tournament
  ON tournament.id = snapshot.tournament_id
  AND tournament.standings_ready_at IS NOT NULL;

ALTER VIEW public.v_tournament_snapshot SET (security_invoker = true);

-- Preserve the legacy selection-stat calculation while adding the same
-- readiness barrier. The table is a write checkpoint, not a replacement for
-- the view's current picks/transfers aggregation semantics.
CREATE OR REPLACE VIEW public.v_tournament_selection_stats AS
WITH pick_data AS (
  SELECT
    te.tournament_id,
    eer.event_id,
    (pick.item ->> 'element')::int AS element_id,
    COUNT(*) AS pick_count,
    COUNT(*) FILTER (WHERE (pick.item ->> 'is_captain')::boolean) AS captain_count,
    COUNT(*) FILTER (WHERE (pick.item ->> 'is_vice_captain')::boolean) AS vice_captain_count
  FROM public.tournament_entries te
  JOIN public.entry_event_results eer ON eer.entry_id = te.entry_id
  CROSS JOIN LATERAL jsonb_array_elements(eer.event_picks) AS pick(item)
  GROUP BY te.tournament_id, eer.event_id, (pick.item ->> 'element')::int
), transfer_in AS (
  SELECT
    te.tournament_id,
    eet.event_id,
    eet.element_in_id AS element_id,
    COUNT(*) AS transfer_in_count
  FROM public.tournament_entries te
  JOIN public.entry_event_transfers eet ON eet.entry_id = te.entry_id
  WHERE eet.element_in_id IS NOT NULL
  GROUP BY te.tournament_id, eet.event_id, eet.element_in_id
), transfer_out AS (
  SELECT
    te.tournament_id,
    eet.event_id,
    eet.element_out_id AS element_id,
    COUNT(*) AS transfer_out_count
  FROM public.tournament_entries te
  JOIN public.entry_event_transfers eet ON eet.entry_id = te.entry_id
  WHERE eet.element_out_id IS NOT NULL
  GROUP BY te.tournament_id, eet.event_id, eet.element_out_id
), entry_counts AS (
  SELECT
    te.tournament_id,
    eer.event_id,
    COUNT(DISTINCT te.entry_id)::int AS total_entries
  FROM public.tournament_entries te
  JOIN public.entry_event_results eer ON eer.entry_id = te.entry_id
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
  AND ec.event_id = COALESCE(pd.event_id, ti.event_id, to2.event_id)
JOIN public.tournament_infos ready_tournament
  ON ready_tournament.id = ec.tournament_id
  AND ready_tournament.standings_ready_at IS NOT NULL;

ALTER VIEW public.v_tournament_selection_stats SET (security_invoker = true);

-- Dropping and recreating a view removes its old ACL. Restore the same trust
-- boundary explicitly so service-role GraphQL reads continue to work while
-- direct anon/authenticated Data API reads remain revoked.
REVOKE ALL ON TABLE public.v_tournament_event_snapshot FROM PUBLIC;
REVOKE ALL ON TABLE public.v_tournament_snapshot FROM PUBLIC;
REVOKE ALL ON TABLE public.v_tournament_selection_stats FROM PUBLIC;

DO $$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.v_tournament_event_snapshot FROM %I', client_role);
      EXECUTE format('REVOKE ALL ON TABLE public.v_tournament_snapshot FROM %I', client_role);
      EXECUTE format('REVOKE ALL ON TABLE public.v_tournament_selection_stats FROM %I', client_role);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON TABLE public.v_tournament_event_snapshot TO service_role;
    GRANT SELECT ON TABLE public.v_tournament_snapshot TO service_role;
    GRANT SELECT ON TABLE public.v_tournament_selection_stats TO service_role;
  END IF;
END $$;

-- The direct event-result view is also a granted read model. Do not expose
-- canonical tournament rows before the standings publication barrier.
CREATE OR REPLACE VIEW public.v_tournament_event_result AS
SELECT
  tpr.tournament_id,
  tpr.event_id,
  tpr.entry_id,
  tpr.group_id,
  tpr.event_group_rank,
  tpr.event_points,
  tpr.event_cost,
  tpr.event_net_points,
  tpr.event_rank,
  ler.overall_points,
  ler.overall_rank,
  ler.event_chip,
  ler.captain_id,
  ler.captain_points,
  ler.team_value,
  ler.bank,
  COALESCE(ler.entry_name, ei.entry_name) AS entry_name,
  COALESCE(ler.player_name, ei.player_name) AS player_name,
  ti.id AS _tournament_id,
  ti.name AS _tournament_name,
  ti.creator AS _tournament_creator,
  ti.admin_entry_id AS _tournament_admin_entry_id,
  ti.league_id AS _tournament_league_id,
  ti.league_type AS _tournament_league_type,
  ti.total_team_num AS _tournament_total_team_num,
  ti.tournament_mode AS _tournament_tournament_mode,
  ti.group_mode AS _tournament_group_mode,
  ti.group_team_num AS _tournament_group_team_num,
  ti.group_num AS _tournament_group_num,
  ti.group_started_event_id AS _tournament_group_started_event_id,
  ti.group_ended_event_id AS _tournament_group_ended_event_id,
  ti.group_auto_averages AS _tournament_group_auto_averages,
  ti.group_rounds AS _tournament_group_rounds,
  ti.group_play_against_num AS _tournament_group_play_against_num,
  ti.group_qualify_num AS _tournament_group_qualify_num,
  ti.knockout_mode AS _tournament_knockout_mode,
  ti.knockout_team_num AS _tournament_knockout_team_num,
  ti.knockout_rounds AS _tournament_knockout_rounds,
  ti.knockout_event_num AS _tournament_knockout_event_num,
  ti.knockout_started_event_id AS _tournament_knockout_started_event_id,
  ti.knockout_ended_event_id AS _tournament_knockout_ended_event_id,
  ti.knockout_play_against_num AS _tournament_knockout_play_against_num,
  ti.state AS _tournament_state,
  ti.created_at AS _tournament_created_at,
  ti.updated_at AS _tournament_updated_at
FROM public.tournament_points_group_results tpr
JOIN public.tournament_infos ti
  ON ti.id = tpr.tournament_id
  AND ti.standings_ready_at IS NOT NULL
LEFT JOIN public.league_event_results ler
  ON ler.league_id = ti.league_id
  AND ler.league_type::text = ti.league_type::text
  AND ler.event_id = tpr.event_id
  AND ler.entry_id = tpr.entry_id
LEFT JOIN public.entry_infos ei
  ON ei.id = tpr.entry_id;

ALTER VIEW public.v_tournament_event_result SET (security_invoker = true);
REVOKE ALL ON TABLE public.v_tournament_event_result FROM PUBLIC;

DO $$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.v_tournament_event_result FROM %I', client_role);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON TABLE public.v_tournament_event_result TO service_role;
  END IF;
END $$;
