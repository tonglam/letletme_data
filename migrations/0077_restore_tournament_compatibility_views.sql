-- Restore the compatibility views removed by historical migration 0070.
-- Current Data/GraphQL clients and trust-boundary checks still expose these
-- read models, so keep the old contracts behind the service-role boundary.

DROP VIEW IF EXISTS public.v_tournament_snapshot;
DROP VIEW IF EXISTS public.v_tournament_selection_stats;
DROP VIEW IF EXISTS public.v_tournament_event_snapshot;

CREATE VIEW public.v_tournament_event_snapshot AS
SELECT
  tournament_id,
  event_id,
  entry_id,
  tournament_overall_rank,
  overall_rank,
  team_value,
  cum_transfers_num,
  cum_total_costs,
  cum_total_bench_points,
  cum_auto_sub_points,
  tournament_team_value_rank,
  tournament_transfers_rank,
  tournament_costs_rank,
  tournament_bench_points_rank,
  tournament_auto_sub_rank,
  cum_total_captain_points,
  highese_captian_points,
  average_catain_points,
  captain_points_percentage,
  tournament_captain_points_rank,
  tournament_captain_points_percentage_rank,
  most_selected_captain,
  cum_total_gk_points,
  cum_total_def_points,
  cum_total_mid_points,
  cum_total_fwd_points
FROM public.mv_tournament_event_snapshot;

CREATE VIEW public.v_tournament_selection_stats AS
SELECT
  stats.tournament_id,
  stats.event_id,
  stats.total_entries,
  stats.element_id,
  stats.pick_count,
  stats.captain_count,
  stats.vice_captain_count,
  stats.transfer_in_count,
  stats.transfer_out_count
FROM public.tournament_selection_stats AS stats
JOIN public.tournament_infos AS ready_tournament
  ON ready_tournament.id = stats.tournament_id
  AND ready_tournament.standings_ready_at IS NOT NULL;

CREATE VIEW public.v_tournament_snapshot AS
SELECT *
FROM public.mv_tournament_snapshot;

ALTER VIEW public.v_tournament_event_snapshot SET (security_invoker = true);
ALTER VIEW public.v_tournament_selection_stats SET (security_invoker = true);
ALTER VIEW public.v_tournament_snapshot SET (security_invoker = true);

DO $$
DECLARE
  view_name text;
  client_role text;
BEGIN
  FOREACH view_name IN ARRAY ARRAY[
    'v_tournament_event_snapshot',
    'v_tournament_selection_stats',
    'v_tournament_snapshot'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', view_name);
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated']
    LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', view_name, client_role);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role', view_name);
    END IF;
  END LOOP;
END $$;
