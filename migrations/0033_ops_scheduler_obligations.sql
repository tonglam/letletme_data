-- One durable obligation per scheduled job, scope and period.  This is the
-- scheduler's authority; BullMQ remains a delivery mechanism only.
CREATE TABLE ops.scheduler_obligations (
  obligation_id uuid PRIMARY KEY,
  job_name text NOT NULL,
  scope_key text NOT NULL,
  period_key text NOT NULL,
  cadence text NOT NULL,
  timezone text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  source text NOT NULL DEFAULT 'schedule',
  due_at timestamptz NOT NULL,
  generation integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  bull_job_id text,
  run_id uuid,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT scheduler_obligations_status_check CHECK (
    status IN ('pending', 'enqueued', 'running', 'succeeded', 'failed', 'skipped', 'irrecoverable')
  ),
  CONSTRAINT scheduler_obligations_source_check CHECK (
    source IN ('schedule', 'catchup', 'reconcile', 'manual')
  ),
  CONSTRAINT scheduler_obligations_generation_check CHECK (generation >= 0),
  CONSTRAINT scheduler_obligations_attempts_check CHECK (attempts >= 0),
  CONSTRAINT scheduler_obligations_evidence_object_check CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT scheduler_obligations_lease_check CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT scheduler_obligations_identity_check CHECK (
    btrim(job_name) <> '' AND btrim(scope_key) <> '' AND btrim(period_key) <> ''
  )
);

CREATE UNIQUE INDEX scheduler_obligations_identity_key
  ON ops.scheduler_obligations (job_name, scope_key, period_key);
CREATE INDEX scheduler_obligations_due_idx
  ON ops.scheduler_obligations (status, due_at, obligation_id)
  WHERE status IN ('pending', 'failed');
CREATE INDEX scheduler_obligations_lease_idx
  ON ops.scheduler_obligations (lease_expires_at, obligation_id)
  WHERE lease_expires_at IS NOT NULL
    AND status IN ('enqueued', 'running');
CREATE INDEX scheduler_obligations_failure_idx
  ON ops.scheduler_obligations (job_name, status, updated_at DESC NULLS LAST)
  WHERE status IN ('failed', 'irrecoverable');

REVOKE ALL ON TABLE ops.scheduler_obligations FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE ops.scheduler_obligations TO letletme_data_writer;
REVOKE ALL ON TABLE ops.scheduler_obligations FROM letletme_graphql_reader;
