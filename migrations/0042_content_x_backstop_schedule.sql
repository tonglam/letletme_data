-- Backstop scans are a second durable schedule for X account partitions.
-- Existing schedules keep their keys, checkpoints and history and become
-- PRIMARY by default.  The manifest reconciler always keeps BACKSTOP rows;
-- CONTENT_X_BACKSTOP_ENABLED controls whether they are paused or active.

ALTER TABLE content.source_schedules
  ADD COLUMN schedule_role text NOT NULL DEFAULT 'PRIMARY';

ALTER TABLE content.source_schedules
  ADD CONSTRAINT content_source_schedules_role_check
  CHECK (
    schedule_role = 'PRIMARY'
    OR (
      schedule_role = 'BACKSTOP'
      AND adapter_kind = 'X_ACCOUNT'
      AND partition_id IS NOT NULL
    )
  );

DROP INDEX content.content_source_schedules_endpoint_target_idx;
DROP INDEX content.content_source_schedules_partition_target_idx;

CREATE UNIQUE INDEX content_source_schedules_endpoint_target_role_idx
  ON content.source_schedules (endpoint_id, schedule_role)
  WHERE endpoint_id IS NOT NULL;

CREATE UNIQUE INDEX content_source_schedules_partition_target_role_idx
  ON content.source_schedules (partition_id, schedule_role)
  WHERE partition_id IS NOT NULL;

CREATE VIEW content.acquisition_schedule_health
WITH (security_invoker = true) AS
SELECT
  schedule.schedule_id,
  schedule.schedule_key,
  schedule.schedule_role,
  schedule.adapter_kind,
  schedule.partition_id,
  partition.partition_key,
  schedule.status,
  schedule.next_due_at,
  GREATEST(0, EXTRACT(EPOCH FROM (now() - schedule.next_due_at)))::bigint AS due_lag_seconds,
  CASE
    WHEN schedule.checkpoint ? 'checkedAt'
      THEN GREATEST(
        0,
        EXTRACT(
          EPOCH FROM (now() - ((schedule.checkpoint ->> 'checkedAt')::timestamptz))
        )
      )::bigint
    ELSE NULL
  END AS checkpoint_age_seconds,
  schedule.failure_streak,
  schedule.circuit_state,
  schedule.probe_after,
  schedule.lease_expires_at,
  latest_run.run_id AS latest_run_id,
  latest_run.status AS latest_run_status,
  latest_run.failure_class AS latest_failure_class
FROM content.source_schedules AS schedule
LEFT JOIN content.source_partitions AS partition
  ON partition.partition_id = schedule.partition_id
LEFT JOIN LATERAL (
  SELECT run.run_id, run.status, run.failure_class
  FROM content.acquisition_runs AS run
  WHERE run.schedule_id = schedule.schedule_id
  ORDER BY run.created_at DESC, run.run_id DESC
  LIMIT 1
) AS latest_run ON true;

GRANT SELECT ON content.acquisition_schedule_health TO letletme_data_writer;
REVOKE ALL ON content.acquisition_schedule_health FROM letletme_graphql_reader;

COMMENT ON COLUMN content.source_schedules.schedule_role IS
  'PRIMARY is the normal cadence; BACKSTOP is a bounded 12-hour X account sweep.';
COMMENT ON VIEW content.acquisition_schedule_health IS
  'Internal per-schedule health projection including PRIMARY/BACKSTOP role.';
