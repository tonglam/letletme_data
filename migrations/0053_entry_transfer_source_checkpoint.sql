-- Order complete transfer-history replacements by the database-clock token
-- captured before their upstream read. A slow older response must not replace
-- a newer corrected or newly appended history for the same entry.
ALTER TABLE public.entry_infos
  ADD COLUMN IF NOT EXISTS entry_transfers_source_checked_at timestamptz;

COMMENT ON COLUMN public.entry_infos.entry_transfers_source_checked_at IS
  'Database-clock start time of the latest accepted transfer-history source read.';

-- This extends an existing RLS-protected table and does not change its grants
-- or policies.
