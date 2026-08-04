-- Explicit authority marker for the post-match live consolidation. The
-- ordinary ten-minute persistence checkpoint remains separate because it can
-- still contain provisional points after the final flag changes.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS live_snapshot_finalized_at timestamptz;

COMMENT ON COLUMN public.events.live_snapshot_finalized_at IS
  'Timestamp of the latest durable post-match live consolidation; null means no final snapshot is proven.';
