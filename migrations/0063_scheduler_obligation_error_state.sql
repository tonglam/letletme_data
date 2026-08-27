-- Scheduler obligations only retain an error while the current durable state
-- is failed or irrecoverable. Older incident repairs sometimes left a
-- diagnostic message on a later terminal row, while blocker/defer paths could
-- leave one on a pending row. Both made the operator feed look unhealthy and
-- would violate the invariant below even though the current state was not a
-- failed terminal outcome.
-- Preserve structured evidence and retained Bull history; clear only the
-- stale current-state marker before installing the invariant.
UPDATE ops.scheduler_obligations
SET last_error = NULL
WHERE status NOT IN ('failed', 'irrecoverable')
  AND last_error IS NOT NULL;

ALTER TABLE ops.scheduler_obligations
  ADD CONSTRAINT scheduler_obligations_last_error_status_check
  CHECK (last_error IS NULL OR status IN ('failed', 'irrecoverable'));
