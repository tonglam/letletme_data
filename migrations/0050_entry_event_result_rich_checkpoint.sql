-- Rich result evidence follows the atomic core snapshot authority migration.
ALTER TABLE public.entry_event_results
  ADD COLUMN IF NOT EXISTS rich_synced_at timestamptz;

COMMENT ON COLUMN public.entry_event_results.rich_synced_at IS
  'Last successful picks/live-derived result write; core history upserts must preserve it.';

ALTER TABLE public.league_event_results
  ADD COLUMN IF NOT EXISTS source_checked_at timestamptz;

COMMENT ON COLUMN public.league_event_results.source_checked_at IS
  'Source-evidence timestamp captured before reads used to build this league result.';

-- This column belongs to an existing RLS-protected table. It does not create a
-- new Data API object or change the table's grants or policies.
