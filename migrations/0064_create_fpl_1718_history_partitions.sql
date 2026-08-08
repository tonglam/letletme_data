-- Historical FPL archive partition for the 2017/18 season.
-- Data is loaded by scripts/backfill-fpl-history-vaastav.ts.
CREATE TABLE IF NOT EXISTS public.event_1718
  PARTITION OF public.fpl_event_history FOR VALUES IN ('1718');
CREATE TABLE IF NOT EXISTS public.team_1718
  PARTITION OF public.fpl_team_history FOR VALUES IN ('1718');
CREATE TABLE IF NOT EXISTS public.player_1718
  PARTITION OF public.fpl_player_history FOR VALUES IN ('1718');
CREATE TABLE IF NOT EXISTS public.phase_1718
  PARTITION OF public.fpl_phase_history FOR VALUES IN ('1718');
CREATE TABLE IF NOT EXISTS public.event_fixture_1718
  PARTITION OF public.fpl_event_fixture_history FOR VALUES IN ('1718');
CREATE TABLE IF NOT EXISTS public.player_stat_1718
  PARTITION OF public.fpl_player_stat_history FOR VALUES IN ('1718');
CREATE TABLE IF NOT EXISTS public.event_live_1718
  PARTITION OF public.fpl_event_live_history FOR VALUES IN ('1718');
CREATE TABLE IF NOT EXISTS public.event_live_explain_1718
  PARTITION OF public.fpl_event_live_explain_history FOR VALUES IN ('1718');
CREATE TABLE IF NOT EXISTS public.event_live_summary_1718
  PARTITION OF public.fpl_event_live_summary_history FOR VALUES IN ('1718');
CREATE TABLE IF NOT EXISTS public.player_value_1718
  PARTITION OF public.fpl_player_value_history FOR VALUES IN ('1718');
CREATE TABLE IF NOT EXISTS public.player_market_snapshot_1718
  PARTITION OF public.fpl_player_market_snapshot_history FOR VALUES IN ('1718');
CREATE TABLE IF NOT EXISTS public.fpl_player_fixture_stat_1718
  PARTITION OF public.fpl_player_fixture_stat_history FOR VALUES IN ('1718');

DO $$
DECLARE table_name text; client_role text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'event_1718', 'team_1718', 'player_1718', 'phase_1718', 'event_fixture_1718',
    'player_stat_1718', 'event_live_1718', 'event_live_explain_1718',
    'event_live_summary_1718', 'player_value_1718', 'player_market_snapshot_1718',
    'fpl_player_fixture_stat_1718'
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
