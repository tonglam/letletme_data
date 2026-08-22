-- Add a durable round-robin cursor for triggered work and expose internal acquisition health.
-- These views are operational projections only; they are not part of the public GraphQL contract.

ALTER TABLE content.source_receipts
  ADD COLUMN work_planner_checked_at timestamptz;

CREATE OR REPLACE FUNCTION content.try_parse_acquisition_timestamptz(input_value text)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
STRICT
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN input_value::timestamptz;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

CREATE INDEX content_source_receipts_work_planner_idx
  ON content.source_receipts (work_planner_checked_at ASC NULLS FIRST, created_at DESC)
  WHERE content_kind IN ('EPISODE', 'VIDEO');

CREATE OR REPLACE VIEW content.acquisition_endpoint_health
WITH (security_invoker = true) AS
SELECT
  endpoint.endpoint_id,
  endpoint.endpoint_key,
  source.source_key,
  endpoint.adapter_kind,
  endpoint.profile_key,
  endpoint.identity_status,
  endpoint.status AS endpoint_status,
  endpoint.identity_checked_at,
  endpoint.identity_next_check_at,
  partition.partition_id,
  partition.partition_key,
  schedule.schedule_id,
  schedule.schedule_key,
  schedule.status AS schedule_status,
  schedule.next_due_at,
  GREATEST(0, EXTRACT(EPOCH FROM (now() - schedule.next_due_at)))::bigint AS due_lag_seconds,
  schedule.failure_streak,
  schedule.circuit_state,
  schedule.probe_after,
  schedule.cache_not_before,
  schedule.lease_expires_at,
  schedule.bootstrap_completed_at,
  schedule.updated_at,
  checkpoint_state.checked_at AS checkpoint_checked_at,
  CASE
    WHEN checkpoint_state.checked_at IS NOT NULL
      THEN GREATEST(
        0,
        EXTRACT(EPOCH FROM (now() - checkpoint_state.checked_at))
      )::bigint
    ELSE NULL
  END AS checkpoint_age_seconds,
  latest_run.run_id AS latest_run_id,
  latest_run.job_kind AS latest_job_kind,
  latest_run.status AS latest_run_status,
  latest_run.created_at AS latest_run_created_at,
  latest_run.started_at AS latest_run_started_at,
  latest_run.completed_at AS latest_run_completed_at,
  CASE
    WHEN latest_run.started_at IS NOT NULL AND latest_run.completed_at IS NOT NULL
      THEN GREATEST(
        0,
        EXTRACT(EPOCH FROM (latest_run.completed_at - latest_run.started_at)) * 1000
      )::bigint
    ELSE NULL
  END AS latest_latency_ms,
  latest_run.result_count AS latest_result_count,
  latest_run.rejected_count AS latest_rejected_count,
  latest_run.failure_class AS latest_failure_class,
  history.last_success_at,
  history.last_failure_at,
  history.last_saturated_at,
  history.last_gap_at,
  history.last_content_deferred_at,
  history.p50_latency_ms,
  history.p95_latency_ms,
  pending_provider.pending_provider_job_count,
  pending_provider.oldest_pending_provider_job_at,
  CASE
    WHEN pending_provider.oldest_pending_provider_job_at IS NULL THEN NULL
    ELSE GREATEST(
      0,
      EXTRACT(EPOCH FROM (now() - pending_provider.oldest_pending_provider_job_at))
    )::bigint
  END AS pending_provider_job_age_seconds,
  latest_gap.reason AS latest_gap_reason,
  latest_gap.declared_at AS latest_gap_declared_at,
  reconciliation.status AS manifest_reconcile_status,
  reconciliation.error_summary AS manifest_reconcile_error,
  reconciliation.created_at AS manifest_reconciled_at
FROM content.source_endpoints AS endpoint
JOIN content.sources AS source ON source.source_id = endpoint.source_id
LEFT JOIN content.source_partition_members AS member ON member.endpoint_id = endpoint.endpoint_id
LEFT JOIN content.source_partitions AS partition ON partition.partition_id = member.partition_id
LEFT JOIN content.source_schedules AS schedule
  ON schedule.endpoint_id = endpoint.endpoint_id
  OR schedule.partition_id = partition.partition_id
LEFT JOIN LATERAL (
  SELECT CASE
    WHEN jsonb_typeof(schedule.checkpoint -> 'checkedAt') = 'string'
      THEN content.try_parse_acquisition_timestamptz(schedule.checkpoint ->> 'checkedAt')
    ELSE NULL
  END AS checked_at
) AS checkpoint_state ON true
LEFT JOIN LATERAL (
  SELECT run.*
  FROM content.acquisition_runs AS run
  WHERE run.endpoint_id = endpoint.endpoint_id
    OR (partition.partition_id IS NOT NULL AND run.source_partition_id = partition.partition_id)
  ORDER BY run.created_at DESC, run.run_id DESC
  LIMIT 1
) AS latest_run ON true
LEFT JOIN LATERAL (
  SELECT
    max(run.completed_at) FILTER (
      WHERE run.status IN ('EMPTY', 'CHECKED_NO_CHANGE', 'COMPLETED', 'PARTIAL', 'SATURATED')
    ) AS last_success_at,
    max(run.completed_at) FILTER (WHERE run.status = 'FAILED') AS last_failure_at,
    max(run.completed_at) FILTER (WHERE run.status = 'SATURATED') AS last_saturated_at,
    max(run.completed_at) FILTER (WHERE run.status = 'GAP') AS last_gap_at,
    max(run.completed_at) FILTER (WHERE run.status = 'CONTENT_DEFERRED')
      AS last_content_deferred_at,
    percentile_cont(0.5) WITHIN GROUP (
      ORDER BY EXTRACT(EPOCH FROM (run.completed_at - run.started_at)) * 1000
    ) FILTER (WHERE run.started_at IS NOT NULL AND run.completed_at IS NOT NULL)::bigint
      AS p50_latency_ms,
    percentile_cont(0.95) WITHIN GROUP (
      ORDER BY EXTRACT(EPOCH FROM (run.completed_at - run.started_at)) * 1000
    ) FILTER (WHERE run.started_at IS NOT NULL AND run.completed_at IS NOT NULL)::bigint
      AS p95_latency_ms
  FROM (
    SELECT candidate.*
    FROM content.acquisition_runs AS candidate
    WHERE candidate.endpoint_id = endpoint.endpoint_id
      OR (
        partition.partition_id IS NOT NULL
        AND candidate.source_partition_id = partition.partition_id
      )
    ORDER BY candidate.created_at DESC
    LIMIT 50
  ) AS run
) AS history ON true
LEFT JOIN LATERAL (
  SELECT
    count(*)::integer AS pending_provider_job_count,
    min(run.created_at) AS oldest_pending_provider_job_at
  FROM content.acquisition_runs AS run
  WHERE run.endpoint_id = endpoint.endpoint_id
    AND run.provider_job_id IS NOT NULL
    AND run.status IN ('PENDING', 'RUNNING')
) AS pending_provider ON true
LEFT JOIN LATERAL (
  SELECT gap.reason, gap.declared_at
  FROM content.acquisition_gaps AS gap
  WHERE gap.endpoint_id = endpoint.endpoint_id
    OR (partition.partition_id IS NOT NULL AND gap.partition_id = partition.partition_id)
  ORDER BY gap.declared_at DESC
  LIMIT 1
) AS latest_gap ON true
LEFT JOIN LATERAL (
  SELECT result.status, result.error_summary, result.created_at
  FROM content.source_registry_reconciliations AS result
  ORDER BY result.created_at DESC
  LIMIT 1
) AS reconciliation ON true;

CREATE VIEW content.acquisition_budget_health
WITH (security_invoker = true) AS
SELECT
  ledger.ledger_id,
  ledger.scope_kind,
  ledger.scope_key,
  ledger.unit_kind,
  ledger.window_start,
  ledger.window_end,
  ledger.max_units,
  ledger.reserved_units,
  ledger.committed_units,
  GREATEST(0, ledger.max_units - ledger.reserved_units - ledger.committed_units)
    AS bucket_remaining_units,
  ledger.updated_at
FROM content.acquisition_budget_ledgers AS ledger;

CREATE VIEW content.acquisition_triggered_work_health
WITH (security_invoker = true) AS
SELECT
  receipt.receipt_id,
  receipt.receipt_key,
  receipt.content_kind,
  source.source_key,
  endpoint.endpoint_key,
  revision.receipt_revision_id,
  revision.revision_number,
  revision.payload #>> '{transcript,status}' AS transcript_status,
  receipt.work_planner_checked_at,
  latest_run.run_id AS latest_run_id,
  latest_run.job_kind AS latest_job_kind,
  latest_run.status AS latest_run_status,
  latest_run.attempt_no AS latest_attempt_no,
  latest_run.failure_class AS latest_failure_class,
  latest_run.created_at AS latest_run_created_at,
  latest_run.completed_at AS latest_run_completed_at,
  (latest_run.provider_job_id IS NOT NULL AND latest_run.status IN ('PENDING', 'RUNNING'))
    AS provider_job_pending,
  CASE
    WHEN latest_run.provider_job_id IS NOT NULL
      AND latest_run.status IN ('PENDING', 'RUNNING')
      THEN GREATEST(0, EXTRACT(EPOCH FROM (now() - latest_run.created_at)))::bigint
    ELSE NULL
  END AS provider_job_age_seconds,
  run_counts.active_run_count,
  run_counts.provider_submission_count,
  (run_counts.active_run_count > 1) AS duplicate_active_submission
FROM content.source_receipts AS receipt
JOIN content.sources AS source ON source.source_id = receipt.source_id
JOIN content.source_endpoints AS endpoint ON endpoint.endpoint_id = receipt.primary_endpoint_id
JOIN content.source_receipt_revisions AS revision
  ON revision.receipt_revision_id = receipt.current_revision_id
LEFT JOIN LATERAL (
  SELECT run.*
  FROM content.acquisition_runs AS run
  WHERE run.target_receipt_id = receipt.receipt_id
  ORDER BY run.created_at DESC, run.run_id DESC
  LIMIT 1
) AS latest_run ON true
LEFT JOIN LATERAL (
  SELECT
    count(*) FILTER (WHERE run.status IN ('PENDING', 'RUNNING'))::integer AS active_run_count,
    count(DISTINCT run.provider_job_id) FILTER (WHERE run.provider_job_id IS NOT NULL)::integer
      AS provider_submission_count
  FROM content.acquisition_runs AS run
  WHERE run.target_receipt_id = receipt.receipt_id
) AS run_counts ON true
WHERE receipt.content_kind IN ('EPISODE', 'VIDEO');

GRANT SELECT ON content.acquisition_budget_health TO letletme_data_writer;
GRANT SELECT ON content.acquisition_triggered_work_health TO letletme_data_writer;
REVOKE ALL ON FUNCTION content.try_parse_acquisition_timestamptz(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION content.try_parse_acquisition_timestamptz(text)
  TO letletme_data_writer;
REVOKE ALL ON content.acquisition_budget_health FROM letletme_graphql_reader;
REVOKE ALL ON content.acquisition_triggered_work_health FROM letletme_graphql_reader;
REVOKE ALL ON FUNCTION content.try_parse_acquisition_timestamptz(text)
  FROM letletme_graphql_reader;

COMMENT ON COLUMN content.source_receipts.work_planner_checked_at IS
  'Operational round-robin cursor; it does not change the immutable ReceiptRevision payload';
COMMENT ON VIEW content.acquisition_endpoint_health IS
  'Internal endpoint, schedule, recent-run, provider-poll and manifest health projection';
COMMENT ON VIEW content.acquisition_budget_health IS
  'Internal authoritative budget-ledger bucket projection; rolling admission remains code policy';
COMMENT ON VIEW content.acquisition_triggered_work_health IS
  'Internal per-item transcript and triggered-job health without raw provider job identifiers';
