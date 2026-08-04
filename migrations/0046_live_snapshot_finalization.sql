-- Explicit authority marker for the post-match live consolidation. The
-- ordinary ten-minute persistence checkpoint remains separate because it can
-- still contain provisional points after the final flag changes.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS live_snapshot_finalized_at timestamptz;

-- Existing workers only had the shared durable-write fence. Preserve usable
-- historical rows when that older marker is the latest durable evidence: the
-- event is finalized, at least one row exists, and no accepted row predates
-- the marker. Do not compare with events.updated_at here: the daily event
-- sync advances that generic timestamp even when the event payload is
-- unchanged, which would strand every older gameweek. New writes use the
-- explicit post-match marker and do not rely on this inference.
UPDATE public.events AS event
SET live_snapshot_finalized_at = event.live_snapshot_checked_at
WHERE event.finished = true
  AND event.data_checked = true
  AND event.deadline_time IS NOT NULL
  AND event.live_snapshot_checked_at IS NOT NULL
  AND event.live_snapshot_checked_at >= event.deadline_time
  AND EXISTS (
    SELECT 1
    FROM public.event_lives AS live
    WHERE live.event_id = event.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.event_lives AS live
    WHERE live.event_id = event.id
      AND COALESCE(live.updated_at, live.created_at) < event.live_snapshot_checked_at
  );

COMMENT ON COLUMN public.events.live_snapshot_finalized_at IS
  'Timestamp of the latest durable post-match live consolidation; null means no final snapshot is proven.';
