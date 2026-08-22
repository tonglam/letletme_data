-- Generalize the legacy X-only acquisition run into the durable multi-adapter run engine.
-- Legacy rows remain readable; new formal runs are immutable request snapshots targeted at one
-- manifest endpoint or partition.

ALTER TABLE content.acquisition_runs
  ADD COLUMN endpoint_id uuid REFERENCES content.source_endpoints(endpoint_id) ON DELETE RESTRICT,
  ADD COLUMN source_partition_id uuid REFERENCES content.source_partitions(partition_id) ON DELETE RESTRICT,
  ADD COLUMN schedule_id uuid REFERENCES content.source_schedules(schedule_id) ON DELETE RESTRICT,
  ADD COLUMN parent_run_id uuid REFERENCES content.acquisition_runs(run_id) ON DELETE RESTRICT,
  ADD COLUMN job_kind text,
  ADD COLUMN adapter_kind text,
  ADD COLUMN profile_key text,
  ADD COLUMN profile_revision integer,
  ADD COLUMN request_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN request_hash text,
  ADD COLUMN endpoint_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN attempt_no integer NOT NULL DEFAULT 1,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN result_count integer NOT NULL DEFAULT 0,
  ADD COLUMN rejected_count integer NOT NULL DEFAULT 0,
  ADD COLUMN provider text,
  ADD COLUMN provider_job_id text,
  ADD COLUMN provider_units numeric(16, 6),
  ADD COLUMN evidence_mode text,
  ADD COLUMN failure_class text,
  ADD COLUMN failure_details_hash text,
  ADD COLUMN run_metrics jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE content.acquisition_runs
SET status = upper(status);

ALTER TABLE content.acquisition_runs
  ALTER COLUMN group_id DROP NOT NULL,
  ALTER COLUMN mode DROP NOT NULL,
  ALTER COLUMN partition_key DROP NOT NULL,
  DROP CONSTRAINT content_acquisition_runs_status_check,
  ADD CONSTRAINT content_acquisition_runs_status_check CHECK (
    status IN (
      'PENDING',
      'RUNNING',
      'EMPTY',
      'CHECKED_NO_CHANGE',
      'COMPLETED',
      'PARTIAL',
      'SATURATED',
      'FAILED',
      'GAP',
      'BUDGET_DEFERRED',
      'CONTENT_DEFERRED'
    )
  ),
  ADD CONSTRAINT content_acquisition_runs_job_kind_check CHECK (
    job_kind IS NULL OR job_kind IN (
      'X_IDENTITY',
      'X_KEYWORD_SCAN',
      'X_SEMANTIC_SCAN',
      'X_THREAD_FETCH',
      'FEED_POLL',
      'ARTICLE_FETCH',
      'PODCAST_TRANSCRIPT',
      'YOUTUBE_METADATA',
      'YOUTUBE_TRANSCRIPT'
    )
  ),
  ADD CONSTRAINT content_acquisition_runs_adapter_check CHECK (
    adapter_kind IS NULL OR adapter_kind IN (
      'X_ACCOUNT',
      'X_SEMANTIC',
      'RSS_ATOM',
      'PODCAST_FEED',
      'YOUTUBE_CHANNEL',
      'ARTICLE_HTTP',
      'HERMES_TRANSCRIPT',
      'SUPADATA_TRANSCRIPT'
    )
  ),
  ADD CONSTRAINT content_acquisition_runs_formal_contract_check CHECK (
    job_kind IS NULL OR (
      adapter_kind IS NOT NULL
      AND profile_key IS NOT NULL
      AND profile_revision IS NOT NULL
      AND request_hash IS NOT NULL
      AND (
        (endpoint_id IS NOT NULL AND source_partition_id IS NULL)
        OR (endpoint_id IS NULL AND source_partition_id IS NOT NULL)
      )
    )
  ),
  ADD CONSTRAINT content_acquisition_runs_profile_revision_check
    CHECK (profile_revision IS NULL OR profile_revision >= 1),
  ADD CONSTRAINT content_acquisition_runs_attempt_check CHECK (attempt_no >= 1),
  ADD CONSTRAINT content_acquisition_runs_result_counts_check
    CHECK (result_count >= 0 AND rejected_count >= 0),
  ADD CONSTRAINT content_acquisition_runs_request_object_check
    CHECK (jsonb_typeof(request_snapshot) = 'object'),
  ADD CONSTRAINT content_acquisition_runs_endpoint_snapshot_object_check
    CHECK (jsonb_typeof(endpoint_snapshot) = 'object'),
  ADD CONSTRAINT content_acquisition_runs_metrics_object_check
    CHECK (jsonb_typeof(run_metrics) = 'object'),
  ADD CONSTRAINT content_acquisition_runs_request_hash_check
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT content_acquisition_runs_failure_hash_check
    CHECK (failure_details_hash IS NULL OR failure_details_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT content_acquisition_runs_provider_units_check
    CHECK (provider_units IS NULL OR provider_units >= 0),
  ADD CONSTRAINT content_acquisition_runs_evidence_mode_check CHECK (
    evidence_mode IS NULL OR evidence_mode IN (
      'GROK_ATTESTED_FINAL',
      'HTTP_DETERMINISTIC',
      'PROVIDER_ATTESTED',
      'HERMES_TIMESTAMPED'
    )
  );

CREATE INDEX content_acquisition_runs_endpoint_created_idx
  ON content.acquisition_runs (endpoint_id, created_at DESC)
  WHERE endpoint_id IS NOT NULL;
CREATE INDEX content_acquisition_runs_partition_created_idx
  ON content.acquisition_runs (source_partition_id, created_at DESC)
  WHERE source_partition_id IS NOT NULL;
CREATE INDEX content_acquisition_runs_parent_idx
  ON content.acquisition_runs (parent_run_id, created_at)
  WHERE parent_run_id IS NOT NULL;
CREATE INDEX content_acquisition_runs_schedule_created_idx
  ON content.acquisition_runs (schedule_id, created_at DESC)
  WHERE schedule_id IS NOT NULL;
CREATE UNIQUE INDEX content_acquisition_runs_active_schedule_idx
  ON content.acquisition_runs (schedule_id)
  WHERE schedule_id IS NOT NULL AND status IN ('PENDING', 'RUNNING');
CREATE UNIQUE INDEX content_acquisition_runs_active_identity_endpoint_idx
  ON content.acquisition_runs (endpoint_id)
  WHERE job_kind = 'X_IDENTITY' AND status IN ('PENDING', 'RUNNING');
CREATE UNIQUE INDEX content_acquisition_runs_request_attempt_idx
  ON content.acquisition_runs (job_kind, request_hash, attempt_no)
  WHERE job_kind IS NOT NULL AND request_hash IS NOT NULL;
CREATE UNIQUE INDEX content_acquisition_runs_provider_job_idx
  ON content.acquisition_runs (provider, provider_job_id)
  WHERE provider IS NOT NULL AND provider_job_id IS NOT NULL;
CREATE INDEX content_acquisition_runs_lease_idx
  ON content.acquisition_runs (lease_expires_at, run_id)
  WHERE status = 'RUNNING' AND lease_expires_at IS NOT NULL;

CREATE OR REPLACE FUNCTION content.prevent_formal_acquisition_request_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = content, pg_catalog
AS $$
BEGIN
  IF OLD.job_kind IS NOT NULL AND (
    NEW.endpoint_id IS DISTINCT FROM OLD.endpoint_id
    OR NEW.source_partition_id IS DISTINCT FROM OLD.source_partition_id
    OR NEW.schedule_id IS DISTINCT FROM OLD.schedule_id
    OR NEW.parent_run_id IS DISTINCT FROM OLD.parent_run_id
    OR NEW.job_kind IS DISTINCT FROM OLD.job_kind
    OR NEW.adapter_kind IS DISTINCT FROM OLD.adapter_kind
    OR NEW.profile_key IS DISTINCT FROM OLD.profile_key
    OR NEW.profile_revision IS DISTINCT FROM OLD.profile_revision
    OR NEW.request_snapshot IS DISTINCT FROM OLD.request_snapshot
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot
    OR NEW.endpoint_snapshot IS DISTINCT FROM OLD.endpoint_snapshot
    OR NEW.window_start IS DISTINCT FROM OLD.window_start
    OR NEW.window_end IS DISTINCT FROM OLD.window_end
    OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
  ) THEN
    RAISE EXCEPTION 'formal acquisition request snapshots are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER content_acquisition_runs_immutable_request
BEFORE UPDATE ON content.acquisition_runs
FOR EACH ROW EXECUTE FUNCTION content.prevent_formal_acquisition_request_mutation();

CREATE TABLE content.acquisition_gaps (
  gap_id uuid PRIMARY KEY,
  declaring_run_id uuid NOT NULL REFERENCES content.acquisition_runs(run_id) ON DELETE RESTRICT,
  endpoint_id uuid REFERENCES content.source_endpoints(endpoint_id) ON DELETE RESTRICT,
  partition_id uuid REFERENCES content.source_partitions(partition_id) ON DELETE RESTRICT,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  reason text NOT NULL,
  details_hash text,
  declared_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_acquisition_gaps_target_check CHECK (
    (endpoint_id IS NOT NULL AND partition_id IS NULL)
    OR (endpoint_id IS NULL AND partition_id IS NOT NULL)
  ),
  CONSTRAINT content_acquisition_gaps_window_check CHECK (window_end >= window_start),
  CONSTRAINT content_acquisition_gaps_details_hash_check
    CHECK (details_hash IS NULL OR details_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT content_acquisition_gaps_run_window_key
    UNIQUE (declaring_run_id, window_start, window_end)
);

CREATE INDEX content_acquisition_gaps_endpoint_idx
  ON content.acquisition_gaps (endpoint_id, declared_at DESC)
  WHERE endpoint_id IS NOT NULL;
CREATE INDEX content_acquisition_gaps_partition_idx
  ON content.acquisition_gaps (partition_id, declared_at DESC)
  WHERE partition_id IS NOT NULL;

CREATE TABLE content.acquisition_http_traces (
  trace_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES content.acquisition_runs(run_id) ON DELETE CASCADE,
  operation text NOT NULL,
  sequence integer NOT NULL,
  request_metadata_hash text NOT NULL,
  response_metadata_hash text,
  transport_body_hash text,
  final_url_hash text,
  http_status integer,
  redirect_count integer NOT NULL DEFAULT 0,
  response_bytes bigint,
  validator_result text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_acquisition_http_traces_hashes_check CHECK (
    request_metadata_hash ~ '^[0-9a-f]{64}$'
    AND (response_metadata_hash IS NULL OR response_metadata_hash ~ '^[0-9a-f]{64}$')
    AND (transport_body_hash IS NULL OR transport_body_hash ~ '^[0-9a-f]{64}$')
    AND (final_url_hash IS NULL OR final_url_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT content_acquisition_http_traces_status_check
    CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  CONSTRAINT content_acquisition_http_traces_sequence_check CHECK (sequence >= 0),
  CONSTRAINT content_acquisition_http_traces_redirect_check CHECK (redirect_count >= 0),
  CONSTRAINT content_acquisition_http_traces_bytes_check
    CHECK (response_bytes IS NULL OR response_bytes >= 0),
  CONSTRAINT content_acquisition_http_traces_validator_check CHECK (
    validator_result IS NULL OR validator_result IN ('NONE', 'ETAG', 'LAST_MODIFIED', 'BOTH', 'NOT_MODIFIED')
  ),
  CONSTRAINT content_acquisition_http_traces_run_sequence_key UNIQUE (run_id, sequence)
);

CREATE INDEX content_acquisition_http_traces_run_idx
  ON content.acquisition_http_traces (run_id, sequence);

CREATE TABLE content.acquisition_provider_traces (
  trace_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES content.acquisition_runs(run_id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  provider text NOT NULL,
  operation text NOT NULL,
  request_metadata_hash text NOT NULL,
  response_metadata_hash text,
  provider_job_id_hash text,
  provider_units numeric(16, 6),
  terminal_state text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_acquisition_provider_traces_hashes_check CHECK (
    request_metadata_hash ~ '^[0-9a-f]{64}$'
    AND (response_metadata_hash IS NULL OR response_metadata_hash ~ '^[0-9a-f]{64}$')
    AND (provider_job_id_hash IS NULL OR provider_job_id_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT content_acquisition_provider_traces_sequence_check CHECK (sequence >= 0),
  CONSTRAINT content_acquisition_provider_traces_units_check
    CHECK (provider_units IS NULL OR provider_units >= 0),
  CONSTRAINT content_acquisition_provider_traces_run_sequence_key UNIQUE (run_id, sequence)
);

CREATE INDEX content_acquisition_provider_traces_run_idx
  ON content.acquisition_provider_traces (run_id, sequence);

CREATE TABLE content.acquisition_job_outbox (
  outbox_id uuid PRIMARY KEY,
  run_id uuid NOT NULL UNIQUE REFERENCES content.acquisition_runs(run_id) ON DELETE RESTRICT,
  queue_name text NOT NULL,
  job_id text NOT NULL UNIQUE,
  priority integer NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner uuid,
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  last_error_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_acquisition_job_outbox_queue_check CHECK (
    queue_name IN ('content-x-scan', 'content-http-acquisition', 'content-media-transcript')
  ),
  CONSTRAINT content_acquisition_job_outbox_priority_check CHECK (priority BETWEEN 1 AND 1000),
  CONSTRAINT content_acquisition_job_outbox_attempts_check CHECK (attempts >= 0),
  CONSTRAINT content_acquisition_job_outbox_lease_check CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT content_acquisition_job_outbox_error_hash_check CHECK (
    last_error_hash IS NULL OR last_error_hash ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX content_acquisition_job_outbox_pending_idx
  ON content.acquisition_job_outbox (available_at, priority, created_at)
  WHERE delivered_at IS NULL;
CREATE INDEX content_acquisition_job_outbox_reclaim_idx
  ON content.acquisition_job_outbox (lease_expires_at, outbox_id)
  WHERE delivered_at IS NULL AND lease_expires_at IS NOT NULL;

CREATE TABLE content.acquisition_budget_ledgers (
  ledger_id uuid PRIMARY KEY,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  unit_kind text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  max_units numeric(20, 6) NOT NULL,
  reserved_units numeric(20, 6) NOT NULL DEFAULT 0,
  committed_units numeric(20, 6) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_acquisition_budget_ledgers_scope_check
    CHECK (scope_kind IN ('GLOBAL', 'LANE', 'HOST', 'PROVIDER')),
  CONSTRAINT content_acquisition_budget_ledgers_unit_check
    CHECK (unit_kind IN ('CALL', 'REQUEST', 'BYTE', 'CREDIT', 'AUDIO_SECOND')),
  CONSTRAINT content_acquisition_budget_ledgers_window_check CHECK (window_end > window_start),
  CONSTRAINT content_acquisition_budget_ledgers_units_check CHECK (
    max_units >= 0
    AND reserved_units >= 0
    AND committed_units >= 0
    AND reserved_units + committed_units <= max_units
  ),
  CONSTRAINT content_acquisition_budget_ledgers_scope_window_key
    UNIQUE (scope_kind, scope_key, unit_kind, window_start, window_end)
);

CREATE TABLE content.acquisition_budget_reservations (
  reservation_id uuid PRIMARY KEY,
  ledger_id uuid NOT NULL REFERENCES content.acquisition_budget_ledgers(ledger_id) ON DELETE RESTRICT,
  run_id uuid NOT NULL REFERENCES content.acquisition_runs(run_id) ON DELETE RESTRICT,
  units numeric(20, 6) NOT NULL,
  status text NOT NULL DEFAULT 'RESERVED',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_acquisition_budget_reservations_units_check CHECK (units > 0),
  CONSTRAINT content_acquisition_budget_reservations_status_check
    CHECK (status IN ('RESERVED', 'COMMITTED', 'RELEASED')),
  CONSTRAINT content_acquisition_budget_reservations_run_ledger_key UNIQUE (run_id, ledger_id)
);

CREATE INDEX content_acquisition_budget_reservations_ledger_status_idx
  ON content.acquisition_budget_reservations (ledger_id, status);
CREATE INDEX content_acquisition_budget_reservations_run_idx
  ON content.acquisition_budget_reservations (run_id);

REVOKE ALL ON FUNCTION content.prevent_formal_acquisition_request_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION content.prevent_formal_acquisition_request_mutation()
  TO letletme_data_writer;

GRANT SELECT, INSERT, UPDATE ON content.acquisition_gaps TO letletme_data_writer;
GRANT SELECT, INSERT, UPDATE ON content.acquisition_http_traces TO letletme_data_writer;
GRANT SELECT, INSERT, UPDATE ON content.acquisition_provider_traces TO letletme_data_writer;
GRANT SELECT, INSERT, UPDATE ON content.acquisition_job_outbox TO letletme_data_writer;
GRANT SELECT, INSERT, UPDATE ON content.acquisition_budget_ledgers TO letletme_data_writer;
GRANT SELECT, INSERT, UPDATE ON content.acquisition_budget_reservations TO letletme_data_writer;
REVOKE DELETE ON content.acquisition_gaps FROM letletme_data_writer;
REVOKE DELETE ON content.acquisition_http_traces FROM letletme_data_writer;
REVOKE DELETE ON content.acquisition_provider_traces FROM letletme_data_writer;
REVOKE DELETE ON content.acquisition_job_outbox FROM letletme_data_writer;
REVOKE DELETE ON content.acquisition_budget_ledgers FROM letletme_data_writer;
REVOKE DELETE ON content.acquisition_budget_reservations FROM letletme_data_writer;

REVOKE ALL ON content.acquisition_gaps FROM letletme_graphql_reader;
REVOKE ALL ON content.acquisition_http_traces FROM letletme_graphql_reader;
REVOKE ALL ON content.acquisition_provider_traces FROM letletme_graphql_reader;
REVOKE ALL ON content.acquisition_job_outbox FROM letletme_graphql_reader;
REVOKE ALL ON content.acquisition_budget_ledgers FROM letletme_graphql_reader;
REVOKE ALL ON content.acquisition_budget_reservations FROM letletme_graphql_reader;

COMMENT ON COLUMN content.acquisition_runs.request_snapshot IS
  'Immutable adapter request loaded by run ID; secrets and provider credentials are forbidden';
COMMENT ON COLUMN content.acquisition_runs.evidence_mode IS
  'Attested evidence boundary; GROK_ATTESTED_FINAL never claims raw X tool payload verification';
