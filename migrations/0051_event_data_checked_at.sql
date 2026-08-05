-- Preserve the upstream finalization timestamp after rich result evidence.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS data_checked_at timestamptz;

-- Existing finalized events must refresh rich entry results once after this
-- migration. Their current updated_at is the safest available lower bound;
-- subsequent event upserts preserve data_checked_at across routine refreshes.
UPDATE public.events
SET data_checked_at = updated_at
WHERE data_checked = true
  AND data_checked_at IS NULL;

COMMENT ON COLUMN public.events.data_checked_at IS
  'Stable timestamp for the latest false-to-true data_checked transition.';

-- This extends an existing RLS-protected table and does not change its grants
-- or policies.
