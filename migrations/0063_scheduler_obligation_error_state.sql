-- Terminal scheduler obligations only retain an error while the current
-- durable state is failed or irrecoverable. Older incident repairs sometimes
-- left a diagnostic message on a later succeeded/skipped row, which made the
-- operator feed look unhealthy even though the obligation had settled.
-- Preserve the structured evidence and retained Bull history; clear only the
-- stale current-state marker before installing the invariant.
UPDATE ops.scheduler_obligations
SET last_error = NULL
WHERE status IN ('succeeded', 'skipped')
  AND last_error IS NOT NULL;

ALTER TABLE ops.scheduler_obligations
  ADD CONSTRAINT scheduler_obligations_last_error_status_check
  CHECK (last_error IS NULL OR status IN ('failed', 'irrecoverable'));
