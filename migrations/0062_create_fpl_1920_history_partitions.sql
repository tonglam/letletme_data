-- Historical FPL archive partition for the 2019/20 season.
-- Data is loaded by scripts/backfill-fpl-history-vaastav.ts.
CREATE TABLE IF NOT EXISTS public.event_1920
  PARTITION OF public.fpl_event_history FOR VALUES IN ('1920');
CREATE TABLE IF NOT EXISTS public.team_1920
  PARTITION OF public.fpl_team_history FOR VALUES IN ('1920');
CREATE TABLE IF NOT EXISTS public.player_1920
  PARTITION OF public.fpl_player_history FOR VALUES IN ('1920');
CREATE TABLE IF NOT EXISTS public.phase_1920
  PARTITION OF public.fpl_phase_history FOR VALUES IN ('1920');
CREATE TABLE IF NOT EXISTS public.event_fixture_1920
  PARTITION OF public.fpl_event_fixture_history FOR VALUES IN ('1920');
CREATE TABLE IF NOT EXISTS public.player_stat_1920
  PARTITION OF public.fpl_player_stat_history FOR VALUES IN ('1920');
CREATE TABLE IF NOT EXISTS public.event_live_1920
  PARTITION OF public.fpl_event_live_history FOR VALUES IN ('1920');
CREATE TABLE IF NOT EXISTS public.event_live_explain_1920
  PARTITION OF public.fpl_event_live_explain_history FOR VALUES IN ('1920');
CREATE TABLE IF NOT EXISTS public.event_live_summary_1920
  PARTITION OF public.fpl_event_live_summary_history FOR VALUES IN ('1920');
CREATE TABLE IF NOT EXISTS public.player_value_1920
  PARTITION OF public.fpl_player_value_history FOR VALUES IN ('1920');
CREATE TABLE IF NOT EXISTS public.player_market_snapshot_1920
  PARTITION OF public.fpl_player_market_snapshot_history FOR VALUES IN ('1920');
CREATE TABLE IF NOT EXISTS public.fpl_player_fixture_stat_1920
  PARTITION OF public.fpl_player_fixture_stat_history FOR VALUES IN ('1920');

DO $$
DECLARE table_name text; client_role text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'event_1920', 'team_1920', 'player_1920', 'phase_1920', 'event_fixture_1920',
    'player_stat_1920', 'event_live_1920', 'event_live_explain_1920',
    'event_live_summary_1920', 'player_value_1920', 'player_market_snapshot_1920',
    'fpl_player_fixture_stat_1920'
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
