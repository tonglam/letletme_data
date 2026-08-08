-- Keep the partitioned event history shape aligned with the current events
-- table before FPL season archival performs its positional copy.
ALTER TABLE public.events_history
  ADD COLUMN IF NOT EXISTS data_checked_at timestamptz;

COMMENT ON COLUMN public.events_history.data_checked_at IS
  'Stable timestamp for the latest false-to-true data_checked transition.';
