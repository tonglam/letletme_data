-- ============================================================================
-- Align fresh-database columns with TypeScript Drizzle schemas
-- ============================================================================
-- Journaled migration 0005 dropped `updated_at` from several tables and never
-- created it on others (entry_infos, entry_event_transfers, …). App repositories
-- still write these columns via `...timestamps` / onConflict updates, so
-- `db:migrate` + `db:apply-sql` on an empty Postgres left CI integration broken
-- with "column updated_at does not exist" / "last_event_id does not exist".
--
-- Idempotent: safe on production DBs that already have the columns.
-- ============================================================================

-- Re-add columns removed by 0005_easy_zarda.sql
ALTER TABLE teams ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE players ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE phases ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- entry_infos: schema has timestamps + last_event_id (never journaled)
ALTER TABLE entry_infos ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE entry_infos ADD COLUMN IF NOT EXISTS last_event_id integer DEFAULT 0;

ALTER TABLE entry_league_infos ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE entry_history_infos ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- Entry event tables created without updated_at in 0005
ALTER TABLE entry_event_picks ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE entry_event_transfers ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- Live tables (after 0006 renames event_live → event_lives)
ALTER TABLE IF EXISTS event_lives ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE IF EXISTS event_live_explains ADD COLUMN IF NOT EXISTS updated_at timestamptz;
