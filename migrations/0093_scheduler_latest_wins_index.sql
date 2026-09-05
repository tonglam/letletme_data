-- Latest-wins lanes compare the immutable scheduled boundary stored in
-- evidence, while retry/backoff is allowed to move due_at. Keep that
-- expression indexed only for obligations the lane may still supersede so a
-- 30-second control tick never scans terminal scheduler history.
CREATE INDEX IF NOT EXISTS scheduler_obligations_latest_wins_idx
  ON ops.scheduler_obligations (
    job_name,
    scope_key,
    (
      CASE
        WHEN evidence->>'scheduledDueAtMs' ~ '^[0-9]+$'
          AND (evidence->>'scheduledDueAtMs')::numeric BETWEEN 0 AND 8640000000000000
          THEN to_timestamp((evidence->>'scheduledDueAtMs')::double precision / 1000)
        ELSE due_at
      END
    ),
    period_key,
    obligation_id
  )
  WHERE status IN ('pending', 'failed', 'enqueued');
