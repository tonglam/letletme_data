-- Bound lock acquisition so a busy deployment fails safely instead of queuing writers.
SET LOCAL lock_timeout = '5s';

-- Admission counts must visit only active X runs, not all acquisition history.
CREATE INDEX content_acquisition_runs_active_x_lease_idx
  ON content.acquisition_runs (lease_expires_at)
  WHERE adapter_kind IN ('X_ACCOUNT', 'X_SEMANTIC')
    AND status IN ('PENDING', 'RUNNING');

-- Preserve every nonterminal state while excluding terminal history from orphan checks.
CREATE INDEX scheduler_obligations_nonterminal_job_idx
  ON ops.scheduler_obligations (job_name)
  WHERE status NOT IN ('succeeded', 'skipped', 'irrecoverable');
