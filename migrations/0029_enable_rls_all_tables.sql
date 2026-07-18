-- ============================================================================
-- FP-20 · Enable Row Level Security on all application tables
-- ============================================================================
-- This migration is idempotent: re-running it is a no-op on already-secured
-- tables. It is ledgered in `sql_migrations` by `bun run db:apply-sql`.
--
-- Reality documented in docs/RLS_SECURITY.md:
--   - The application connects with a role that BYPASSES RLS (service role /
--     `supabase_admin`), so these policies do not restrict the backend.
--   - They protect the Supabase Data API (PostgREST) against unauthenticated
--     reads/writes when tables are exposed.
--
-- Classification:
--   - PUBLIC_READ tables: anonymous can SELECT; authenticated can do ALL.
--   - AUTHENTICATED_ONLY tables: no anonymous access; authenticated can do ALL.
--
-- Identifier note: PostgreSQL truncates identifiers to 63 bytes (NAMEDATALEN-1).
-- Policy names must be truncated with left(..., 63) *before* both the
-- pg_policies existence check and CREATE POLICY. Checking the untruncated name
-- while CREATE POLICY stores the truncated form causes false misses and
-- "policy already exists" on re-run (deploy failure on long table names).
-- ============================================================================

DO $$
DECLARE
    v_table text;
    v_policy text;
    v_public_tables text[] := ARRAY[
        'events',
        'fixtures',
        'phases',
        'teams',
        'players',
        'player_values',
        'player_stats',
        'event_fixtures',
        'event_lives',
        'event_live_explains',
        'event_live_summaries'
    ];
    v_auth_only_tables text[] := ARRAY[
        'entry_infos',
        'entry_league_infos',
        'entry_history_infos',
        'entry_event_picks',
        'entry_event_transfers',
        'entry_event_results',
        'entry_event_cup_results',
        'league_event_results',
        'tournament_infos',
        'tournament_entries',
        'tournament_groups',
        'tournament_points_group_results',
        'tournament_battle_group_results',
        'tournament_knockouts',
        'tournament_knockout_results',
        'tournament_selection_stats',
        'sql_migrations'
    ];
BEGIN
    -- Public-read tables
    FOREACH v_table IN ARRAY v_public_tables
    LOOP
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = v_table) THEN
            EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_table);

            -- Match Postgres identifier truncation so re-runs find existing policies.
            v_policy := left('Allow public read access to ' || v_table, 63);
            IF NOT EXISTS (
                SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = v_table AND policyname = v_policy
            ) THEN
                EXECUTE format(
                    'CREATE POLICY %I ON %I FOR SELECT TO public USING (true)',
                    v_policy, v_table
                );
            END IF;

            v_policy := left('Allow authenticated write access to ' || v_table, 63);
            IF NOT EXISTS (
                SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = v_table AND policyname = v_policy
            ) THEN
                EXECUTE format(
                    'CREATE POLICY %I ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
                    v_policy, v_table
                );
            END IF;
        END IF;
    END LOOP;

    -- Authenticated-only tables
    FOREACH v_table IN ARRAY v_auth_only_tables
    LOOP
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = v_table) THEN
            EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_table);

            v_policy := left('Allow authenticated full access to ' || v_table, 63);
            IF NOT EXISTS (
                SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = v_table AND policyname = v_policy
            ) THEN
                EXECUTE format(
                    'CREATE POLICY %I ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
                    v_policy, v_table
                );
            END IF;
        END IF;
    END LOOP;
END $$;

-- bauth schema tables: authenticated-only access via Data API (app bypasses RLS).
DO $$
DECLARE
    v_table text;
    v_policy text;
    v_bauth_tables text[] := ARRAY['user', 'session', 'account', 'verification', 'apikey'];
BEGIN
    FOREACH v_table IN ARRAY v_bauth_tables
    LOOP
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'bauth' AND tablename = v_table) THEN
            EXECUTE format('ALTER TABLE bauth.%I ENABLE ROW LEVEL SECURITY', v_table);

            v_policy := left('Allow authenticated full access to bauth.' || v_table, 63);
            IF NOT EXISTS (
                SELECT 1 FROM pg_policies
                WHERE schemaname = 'bauth' AND tablename = v_table AND policyname = v_policy
            ) THEN
                EXECUTE format(
                    'CREATE POLICY %I ON bauth.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
                    v_policy, v_table
                );
            END IF;
        END IF;
    END LOOP;
END $$;
