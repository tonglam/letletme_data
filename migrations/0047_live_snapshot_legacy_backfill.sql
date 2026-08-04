-- The explicit final marker was introduced after the original durable fence.
-- Recover older finalized events from their last fenced snapshot, while
-- leaving rows without a complete snapshot unavailable until reconsolidated.
-- Do not compare with events.updated_at: the daily event sync advances that
-- generic timestamp even when an historical event is unchanged.
UPDATE public.events AS event
SET live_snapshot_finalized_at = event.live_snapshot_checked_at
WHERE event.live_snapshot_finalized_at IS NULL
  AND event.finished = true
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
