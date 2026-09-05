ALTER TABLE ops.queue_health_windows
  ADD COLUMN IF NOT EXISTS consumer_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS paused_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pause_owner_state text NOT NULL DEFAULT 'NONE';

ALTER TABLE ops.queue_health_windows
  DROP CONSTRAINT IF EXISTS queue_health_windows_pause_owner_check,
  DROP CONSTRAINT IF EXISTS queue_health_windows_counts_nonnegative;

ALTER TABLE ops.queue_health_windows
  ADD CONSTRAINT queue_health_windows_pause_owner_check
    CHECK (pause_owner_state = ANY (ARRAY['NONE','DEPLOYMENT','ACQUIRING','OPERATOR','RELEASING'])),
  ADD CONSTRAINT queue_health_windows_counts_nonnegative
    CHECK (waiting >= 0 AND active >= 0 AND delayed >= 0 AND prioritized >= 0
      AND waiting_children >= 0 AND paused_count >= 0 AND failed >= 0
      AND completed >= 0 AND runnable >= 0 AND arrivals >= 0 AND completions >= 0
      AND failures >= 0 AND stalled >= 0);
