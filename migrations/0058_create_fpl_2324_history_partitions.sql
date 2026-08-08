-- Historical FPL archive partition for the 2023/24 season.
-- Data is loaded by scripts/backfill-fpl-history-vaastav.ts.
CREATE TABLE IF NOT EXISTS public.event_2324
  PARTITION OF public.fpl_event_history FOR VALUES IN ('2324');
CREATE TABLE IF NOT EXISTS public.team_2324
  PARTITION OF public.fpl_team_history FOR VALUES IN ('2324');
CREATE TABLE IF NOT EXISTS public.player_2324
  PARTITION OF public.fpl_player_history FOR VALUES IN ('2324');
CREATE TABLE IF NOT EXISTS public.phase_2324
  PARTITION OF public.fpl_phase_history FOR VALUES IN ('2324');
CREATE TABLE IF NOT EXISTS public.event_fixture_2324
  PARTITION OF public.fpl_event_fixture_history FOR VALUES IN ('2324');
CREATE TABLE IF NOT EXISTS public.player_stat_2324
  PARTITION OF public.fpl_player_stat_history FOR VALUES IN ('2324');
CREATE TABLE IF NOT EXISTS public.event_live_2324
  PARTITION OF public.fpl_event_live_history FOR VALUES IN ('2324');
CREATE TABLE IF NOT EXISTS public.event_live_explain_2324
  PARTITION OF public.fpl_event_live_explain_history FOR VALUES IN ('2324');
CREATE TABLE IF NOT EXISTS public.event_live_summary_2324
  PARTITION OF public.fpl_event_live_summary_history FOR VALUES IN ('2324');
CREATE TABLE IF NOT EXISTS public.player_value_2324
  PARTITION OF public.fpl_player_value_history FOR VALUES IN ('2324');
CREATE TABLE IF NOT EXISTS public.player_market_snapshot_2324
  PARTITION OF public.fpl_player_market_snapshot_history FOR VALUES IN ('2324');
CREATE TABLE IF NOT EXISTS public.fpl_player_fixture_stat_2324
  PARTITION OF public.fpl_player_fixture_stat_history FOR VALUES IN ('2324');

DO $$
DECLARE table_name text; client_role text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'event_2324', 'team_2324', 'player_2324', 'phase_2324', 'event_fixture_2324',
    'player_stat_2324', 'event_live_2324', 'event_live_explain_2324',
    'event_live_summary_2324', 'player_value_2324', 'player_market_snapshot_2324',
    'fpl_player_fixture_stat_2324'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', table_name);
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', table_name, client_role);
      END IF;
    END LOOP;
  END LOOP;
END $$;
