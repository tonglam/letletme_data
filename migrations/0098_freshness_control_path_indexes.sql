-- Keep freshness observer and latest-wins retirement scans on their live rows.
-- The existing pending-only and breach indexes do not cover INVALID rows,
-- while both control paths deliberately inspect PENDING and INVALID together.
SET LOCAL lock_timeout = '5s';

CREATE INDEX freshness_slo_windows_observer_due_idx
  ON ops.freshness_slo_windows (due_at, window_id DESC)
  WHERE status IN ('PENDING','INVALID');

-- Latest-wins supersession filters by contract, scope, and the immutable
-- obligation deadline.  Do not make the control update scan every historical
-- freshness window when it retires one scope.
CREATE INDEX freshness_slo_windows_supersede_idx
  ON ops.freshness_slo_windows (contract_key, scope_key, obligation_due_at)
  WHERE status IN ('PENDING','INVALID');
