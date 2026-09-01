-- Non-terminal Bull failures are a retry state, not a successful running
-- lease and not a terminal scheduler failure. Persist the next retry boundary
-- so status/probes can tell operators exactly what will happen next.
ALTER TABLE ops.scheduler_obligations
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

ALTER TABLE ops.scheduler_obligations
  DROP CONSTRAINT IF EXISTS scheduler_obligations_status_check,
  DROP CONSTRAINT IF EXISTS scheduler_obligations_last_error_status_check;

ALTER TABLE ops.scheduler_obligations
  ADD CONSTRAINT scheduler_obligations_status_check CHECK (
    status IN ('pending', 'enqueued', 'running', 'retrying', 'succeeded', 'failed', 'skipped', 'irrecoverable')
  ),
  ADD CONSTRAINT scheduler_obligations_last_error_status_check CHECK (
    last_error IS NULL OR status IN ('retrying', 'failed', 'irrecoverable')
  );

CREATE INDEX IF NOT EXISTS scheduler_obligations_retry_idx
  ON ops.scheduler_obligations (next_attempt_at, obligation_id)
  WHERE status = 'retrying';
