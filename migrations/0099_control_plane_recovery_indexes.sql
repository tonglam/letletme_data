-- Keep lease-recovery transactions on the small set of triggered runs that
-- can actually be reclaimed. The planner's old predicate had no matching
-- partial index and scanned all acquisition history on every pass.
SET LOCAL lock_timeout = '5s';

CREATE INDEX content_acquisition_runs_trigger_recovery_idx
  ON content.acquisition_runs (lease_expires_at, run_id)
  WHERE schedule_id IS NULL
    AND job_kind <> 'X_IDENTITY'
    AND status IN ('PENDING', 'RUNNING')
    AND lease_expires_at IS NOT NULL;

-- The media worker expires exhausted repair windows in the same claim
-- transaction. Its predicate is different from the due-claim index because
-- next_attempt_at may be NULL after the final retry.
CREATE INDEX content_source_media_gates_repair_expiry_idx
  ON content.source_media_gates (repair_until_at, gate_id)
  WHERE status IN ('PENDING', 'PARTIAL', 'UNAVAILABLE')
    AND repair_exhausted_at IS NULL;
