-- Keep local FPL admission saturation separate from provider throttling.  The
-- queue monitor stores admission wait/error evidence in the existing JSONB
-- evidence column; this migration only extends the durable class enum check.
ALTER TABLE ops.queue_health_windows
  DROP CONSTRAINT IF EXISTS queue_health_windows_backlog_class_check;

ALTER TABLE ops.queue_health_windows
  ADD CONSTRAINT queue_health_windows_backlog_class_check CHECK (
    backlog_class = ANY (ARRAY[
      'NO_CONSUMER',
      'POISON_STORM',
      'STALLED',
      'DEADLINE_RISK',
      'ADMISSION_SATURATED',
      'PROVIDER_THROTTLED',
      'BURST',
      'HEALTHY'
    ]::text[])
  );
