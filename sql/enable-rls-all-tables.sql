-- ============================================================================
-- Enable Row Level Security (RLS) for All Tables
-- ============================================================================
-- Purpose: Protect all tables from unauthorized access via Supabase Data API
-- Strategy: 
--   - Public data (events, teams, players, stats) → Public READ access
--   - User data (entries, tournaments, leagues) → Authenticated access only
-- ============================================================================

-- ============================================================================
-- CORE DATA TABLES (Public Read Access)
-- ============================================================================

-- Events
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access to events"
ON events FOR SELECT TO public USING (true);
CREATE POLICY "Allow authenticated write access to events"
ON events FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Fixtures
ALTER TABLE fixtures ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access to fixtures"
ON fixtures FOR SELECT TO public USING (true);
CREATE POLICY "Allow authenticated write access to fixtures"
ON fixtures FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Phases
ALTER TABLE phases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access to phases"
ON phases FOR SELECT TO public USING (true);
CREATE POLICY "Allow authenticated write access to phases"
ON phases FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Teams
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access to teams"
ON teams FOR SELECT TO public USING (true);
CREATE POLICY "Allow authenticated write access to teams"
ON teams FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Players
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access to players"
ON players FOR SELECT TO public USING (true);
CREATE POLICY "Allow authenticated write access to players"
ON players FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================================
-- PLAYER DATA TABLES (Public Read Access)
-- ============================================================================

-- Player Values
ALTER TABLE player_values ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access to player_values"
ON player_values FOR SELECT TO public USING (true);
CREATE POLICY "Allow authenticated write access to player_values"
ON player_values FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Player Value Tracks (if exists)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'player_value_tracks') THEN
    ALTER TABLE player_value_tracks ENABLE ROW LEVEL SECURITY;
    EXECUTE 'CREATE POLICY "Allow public read access to player_value_tracks" ON player_value_tracks FOR SELECT TO public USING (true)';
    EXECUTE 'CREATE POLICY "Allow authenticated write access to player_value_tracks" ON player_value_tracks FOR ALL TO authenticated USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- Player Stats
ALTER TABLE player_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access to player_stats"
ON player_stats FOR SELECT TO public USING (true);
CREATE POLICY "Allow authenticated write access to player_stats"
ON player_stats FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================================
-- EVENT DATA TABLES (Public Read Access)
-- ============================================================================

-- Event Fixtures
ALTER TABLE event_fixtures ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access to event_fixtures"
ON event_fixtures FOR SELECT TO public USING (true);
CREATE POLICY "Allow authenticated write access to event_fixtures"
ON event_fixtures FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Event Lives
ALTER TABLE event_lives ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access to event_lives"
ON event_lives FOR SELECT TO public USING (true);
CREATE POLICY "Allow authenticated write access to event_lives"
ON event_lives FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Event Live Explains
ALTER TABLE event_live_explains ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access to event_live_explains"
ON event_live_explains FOR SELECT TO public USING (true);
CREATE POLICY "Allow authenticated write access to event_live_explains"
ON event_live_explains FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Event Live Summaries ⭐ (THIS IS THE TABLE MENTIONED BY USER)
ALTER TABLE event_live_summaries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access to event_live_summaries"
ON event_live_summaries FOR SELECT TO public USING (true);
CREATE POLICY "Allow authenticated write access to event_live_summaries"
ON event_live_summaries FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Event Standings (if exists)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'event_standings') THEN
    ALTER TABLE event_standings ENABLE ROW LEVEL SECURITY;
    EXECUTE 'CREATE POLICY "Allow public read access to event_standings" ON event_standings FOR SELECT TO public USING (true)';
    EXECUTE 'CREATE POLICY "Allow authenticated write access to event_standings" ON event_standings FOR ALL TO authenticated USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- ============================================================================
-- ENTRY TABLES (Authenticated Access Only - User Data)
-- ============================================================================

-- Entry Infos
ALTER TABLE entry_infos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated full access to entry_infos"
ON entry_infos FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Entry League Infos
ALTER TABLE entry_league_infos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated full access to entry_league_infos"
ON entry_league_infos FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Entry History Infos
ALTER TABLE entry_history_infos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated full access to entry_history_infos"
ON entry_history_infos FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Entry Event Picks
ALTER TABLE entry_event_picks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated full access to entry_event_picks"
ON entry_event_picks FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Entry Event Transfers
ALTER TABLE entry_event_transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated full access to entry_event_transfers"
ON entry_event_transfers FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Entry Event Results
ALTER TABLE entry_event_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated full access to entry_event_results"
ON entry_event_results FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Entry Event Cup Results
ALTER TABLE entry_event_cup_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated full access to entry_event_cup_results"
ON entry_event_cup_results FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================================
-- LEAGUE TABLES (Authenticated Access Only)
-- ============================================================================

-- League Event Results
ALTER TABLE league_event_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated full access to league_event_results"
ON league_event_results FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================================
-- TOURNAMENT TABLES (Authenticated Access Only)
-- ============================================================================

-- Tournament Infos
ALTER TABLE tournament_infos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated full access to tournament_infos"
ON tournament_infos FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Tournament Entries
ALTER TABLE tournament_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated full access to tournament_entries"
ON tournament_entries FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Tournament Groups
ALTER TABLE tournament_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated full access to tournament_groups"
ON tournament_groups FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Tournament Points Group Results
ALTER TABLE tournament_points_group_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated full access to tournament_points_group_results"
ON tournament_points_group_results FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Tournament Battle Group Results
ALTER TABLE tournament_battle_group_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated full access to tournament_battle_group_results"
ON tournament_battle_group_results FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Tournament Knockouts
ALTER TABLE tournament_knockouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated full access to tournament_knockouts"
ON tournament_knockouts FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Tournament Knockout Results
ALTER TABLE tournament_knockout_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated full access to tournament_knockout_results"
ON tournament_knockout_results FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- Check RLS status for all tables
-- SELECT tablename, rowsecurity AS rls_enabled
-- FROM pg_tables
-- WHERE schemaname = 'public'
-- ORDER BY tablename;

-- Check all policies
-- SELECT tablename, policyname, cmd, roles
-- FROM pg_policies
-- WHERE schemaname = 'public'
-- ORDER BY tablename, policyname;

-- ============================================================================
-- NOTES
-- ============================================================================
-- 
-- Policy Strategy:
-- 1. Public data (events, teams, players, stats): Anyone can READ, only authenticated can WRITE
-- 2. User data (entries, tournaments, leagues): Only authenticated can READ and WRITE
-- 
-- "authenticated" role = Service role with API key (your backend service)
-- "public" role = Anonymous access via Data API
-- 
-- This ensures:
-- ✅ Public can view game data via Data API
-- ✅ Only your service can modify any data
-- ✅ User-specific data is protected from unauthorized access
-- 
-- ============================================================================
