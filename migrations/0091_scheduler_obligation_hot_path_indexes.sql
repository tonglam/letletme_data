-- Keep scheduler coordination queries on the small set of live obligations.
-- Historical succeeded/skipped rows must not compete with in-flight or
-- pending/failed scheduling decisions.
CREATE INDEX IF NOT EXISTS scheduler_obligations_inflight_job_idx
  ON ops.scheduler_obligations (job_name, obligation_id)
  WHERE status IN ('enqueued', 'running', 'retrying');

CREATE INDEX IF NOT EXISTS scheduler_obligations_pending_job_scope_idx
  ON ops.scheduler_obligations (job_name, scope_key, period_key, obligation_id)
  WHERE status IN ('pending', 'failed');
