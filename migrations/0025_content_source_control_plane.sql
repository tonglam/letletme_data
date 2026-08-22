-- Manifest-managed Briefing acquisition control plane. This migration is additive: legacy
-- source/group readers remain available while new acquisition code uses Entity/Endpoint state.

ALTER TABLE content.sources
  ADD COLUMN source_key text,
  ADD COLUMN origin text,
  ADD COLUMN manifest_revision text;

UPDATE content.sources
SET
  source_key = COALESCE(source_key, 'legacy-' || replace(source_id::text, '-', '')),
  origin = COALESCE(origin, 'DISCOVERED'),
  status = CASE WHEN status = 'disabled' THEN 'paused' ELSE status END;

ALTER TABLE content.sources
  ALTER COLUMN source_key SET NOT NULL,
  ALTER COLUMN origin SET NOT NULL,
  ALTER COLUMN origin SET DEFAULT 'MANIFEST',
  ALTER COLUMN platform DROP NOT NULL,
  ALTER COLUMN external_id DROP NOT NULL,
  DROP CONSTRAINT content_sources_status_check,
  ADD CONSTRAINT content_sources_status_check
    CHECK (status IN ('active', 'paused', 'observed', 'dormant')),
  ADD CONSTRAINT content_sources_source_key_format_check
    CHECK (source_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  ADD CONSTRAINT content_sources_origin_check
    CHECK (origin IN ('MANIFEST', 'DISCOVERED')),
  ADD CONSTRAINT content_sources_manifest_revision_check
    CHECK (manifest_revision IS NULL OR manifest_revision ~ '^[0-9a-f]{64}$');

ALTER TABLE content.sources
  ADD CONSTRAINT content_sources_source_key_key UNIQUE (source_key);

CREATE TABLE content.source_endpoints (
  endpoint_id uuid PRIMARY KEY,
  endpoint_key text NOT NULL UNIQUE,
  source_id uuid NOT NULL REFERENCES content.sources(source_id) ON DELETE RESTRICT,
  adapter_kind text NOT NULL,
  profile_key text NOT NULL,
  locator jsonb NOT NULL,
  stable_external_id text,
  identity_status text NOT NULL DEFAULT 'PENDING',
  identity_error_summary text,
  identity_checked_at timestamptz,
  identity_next_check_at timestamptz,
  status text NOT NULL DEFAULT 'active',
  origin text NOT NULL DEFAULT 'MANIFEST',
  rights_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  manifest_revision text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_source_endpoints_key_format_check
    CHECK (endpoint_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT content_source_endpoints_adapter_check CHECK (
    adapter_kind IN ('X_ACCOUNT', 'X_SEMANTIC', 'RSS_ATOM', 'PODCAST_FEED', 'YOUTUBE_CHANNEL')
  ),
  CONSTRAINT content_source_endpoints_identity_status_check
    CHECK (identity_status IN ('PENDING', 'VERIFIED', 'CONFLICT', 'FAILED')),
  CONSTRAINT content_source_endpoints_status_check
    CHECK (status IN ('active', 'paused', 'observed', 'dormant')),
  CONSTRAINT content_source_endpoints_origin_check
    CHECK (origin IN ('MANIFEST', 'DISCOVERED')),
  CONSTRAINT content_source_endpoints_locator_object_check
    CHECK (jsonb_typeof(locator) = 'object'),
  CONSTRAINT content_source_endpoints_rights_object_check
    CHECK (jsonb_typeof(rights_policy) = 'object'),
  CONSTRAINT content_source_endpoints_manifest_revision_check
    CHECK (manifest_revision ~ '^[0-9a-f]{64}$'),
  CONSTRAINT content_source_endpoints_identity_time_check CHECK (
    identity_next_check_at IS NULL
    OR identity_checked_at IS NULL
    OR identity_next_check_at >= identity_checked_at
  )
);

CREATE UNIQUE INDEX content_source_endpoints_stable_external_idx
  ON content.source_endpoints (adapter_kind, stable_external_id)
  WHERE stable_external_id IS NOT NULL;
CREATE INDEX content_source_endpoints_source_idx
  ON content.source_endpoints (source_id, status, adapter_kind);
CREATE INDEX content_source_endpoints_identity_due_idx
  ON content.source_endpoints (identity_next_check_at, endpoint_id)
  WHERE status = 'active' AND identity_status IN ('PENDING', 'FAILED', 'VERIFIED');

CREATE TABLE content.source_partitions (
  partition_id uuid PRIMARY KEY,
  partition_key text NOT NULL UNIQUE,
  adapter_kind text NOT NULL,
  profile_key text NOT NULL,
  priority integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  manifest_revision text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_source_partitions_key_format_check
    CHECK (partition_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT content_source_partitions_adapter_check
    CHECK (adapter_kind IN ('X_ACCOUNT', 'X_SEMANTIC')),
  CONSTRAINT content_source_partitions_priority_check CHECK (priority BETWEEN 1 AND 1000),
  CONSTRAINT content_source_partitions_status_check CHECK (status IN ('active', 'paused')),
  CONSTRAINT content_source_partitions_manifest_revision_check
    CHECK (manifest_revision ~ '^[0-9a-f]{64}$')
);

CREATE TABLE content.source_partition_members (
  partition_id uuid NOT NULL REFERENCES content.source_partitions(partition_id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL REFERENCES content.source_endpoints(endpoint_id) ON DELETE RESTRICT,
  position integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partition_id, endpoint_id),
  CONSTRAINT content_source_partition_members_endpoint_key UNIQUE (endpoint_id),
  CONSTRAINT content_source_partition_members_position_check CHECK (position >= 0),
  CONSTRAINT content_source_partition_members_partition_position_key UNIQUE (partition_id, position)
);

CREATE INDEX content_source_partition_members_endpoint_idx
  ON content.source_partition_members (endpoint_id, partition_id);

CREATE OR REPLACE FUNCTION content.assert_source_partition_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = content, pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM content.source_partition_members AS member
    JOIN content.source_endpoints AS endpoint ON endpoint.endpoint_id = member.endpoint_id
    JOIN content.source_partitions AS partition ON partition.partition_id = member.partition_id
    WHERE endpoint.adapter_kind NOT IN ('X_ACCOUNT', 'X_SEMANTIC')
      OR endpoint.adapter_kind <> partition.adapter_kind
      OR endpoint.profile_key <> partition.profile_key
  ) THEN
    RAISE EXCEPTION 'source partition members must match X adapter and profile'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER content_source_partition_members_contract
AFTER INSERT OR UPDATE ON content.source_partition_members
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION content.assert_source_partition_contract();

CREATE CONSTRAINT TRIGGER content_source_endpoints_partition_contract
AFTER UPDATE OF adapter_kind, profile_key ON content.source_endpoints
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION content.assert_source_partition_contract();

CREATE CONSTRAINT TRIGGER content_source_partitions_member_contract
AFTER UPDATE OF adapter_kind, profile_key ON content.source_partitions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION content.assert_source_partition_contract();

CREATE TABLE content.source_schedules (
  schedule_id uuid PRIMARY KEY,
  schedule_key text NOT NULL UNIQUE,
  endpoint_id uuid REFERENCES content.source_endpoints(endpoint_id) ON DELETE RESTRICT,
  partition_id uuid REFERENCES content.source_partitions(partition_id) ON DELETE RESTRICT,
  job_kind text NOT NULL,
  adapter_kind text NOT NULL,
  profile_key text NOT NULL,
  profile_revision integer NOT NULL,
  priority integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  next_due_at timestamptz NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  failure_streak integer NOT NULL DEFAULT 0,
  circuit_state text NOT NULL DEFAULT 'CLOSED',
  probe_after timestamptz,
  cache_not_before timestamptz,
  validator jsonb NOT NULL DEFAULT '{}'::jsonb,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  bootstrap_completed_at timestamptz,
  bootstrap_cutoff_at timestamptz,
  under_limit_streak integer NOT NULL DEFAULT 0,
  manifest_revision text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_source_schedules_key_format_check
    CHECK (schedule_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT content_source_schedules_target_check CHECK (
    (endpoint_id IS NOT NULL AND partition_id IS NULL)
    OR (endpoint_id IS NULL AND partition_id IS NOT NULL)
  ),
  CONSTRAINT content_source_schedules_adapter_check CHECK (
    adapter_kind IN ('X_ACCOUNT', 'X_SEMANTIC', 'RSS_ATOM', 'PODCAST_FEED', 'YOUTUBE_CHANNEL')
  ),
  CONSTRAINT content_source_schedules_profile_revision_check CHECK (profile_revision >= 1),
  CONSTRAINT content_source_schedules_priority_check CHECK (priority BETWEEN 1 AND 1000),
  CONSTRAINT content_source_schedules_status_check CHECK (status IN ('active', 'paused')),
  CONSTRAINT content_source_schedules_failure_streak_check CHECK (failure_streak >= 0),
  CONSTRAINT content_source_schedules_under_limit_streak_check CHECK (under_limit_streak >= 0),
  CONSTRAINT content_source_schedules_circuit_check
    CHECK (circuit_state IN ('CLOSED', 'OPEN', 'HALF_OPEN')),
  CONSTRAINT content_source_schedules_validator_object_check
    CHECK (jsonb_typeof(validator) = 'object'),
  CONSTRAINT content_source_schedules_checkpoint_object_check
    CHECK (jsonb_typeof(checkpoint) = 'object'),
  CONSTRAINT content_source_schedules_lease_check CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT content_source_schedules_bootstrap_time_check CHECK (
    bootstrap_completed_at IS NULL
    OR bootstrap_cutoff_at IS NULL
    OR bootstrap_completed_at >= bootstrap_cutoff_at
  ),
  CONSTRAINT content_source_schedules_manifest_revision_check
    CHECK (manifest_revision ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX content_source_schedules_endpoint_target_idx
  ON content.source_schedules (endpoint_id)
  WHERE endpoint_id IS NOT NULL;
CREATE UNIQUE INDEX content_source_schedules_partition_target_idx
  ON content.source_schedules (partition_id)
  WHERE partition_id IS NOT NULL;
CREATE INDEX content_source_schedules_due_idx
  ON content.source_schedules (priority, next_due_at, schedule_id)
  WHERE status = 'active' AND lease_expires_at IS NULL;
CREATE INDEX content_source_schedules_reclaim_idx
  ON content.source_schedules (lease_expires_at, schedule_id)
  WHERE status = 'active' AND lease_expires_at IS NOT NULL;

ALTER TABLE content.source_schedules
  ADD CONSTRAINT content_source_schedules_job_kind_check CHECK (
    job_kind IN (
      'X_KEYWORD_SCAN',
      'X_SEMANTIC_SCAN',
      'FEED_POLL'
    )
  );

CREATE OR REPLACE FUNCTION content.assert_source_schedule_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = content, pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM content.source_schedules AS schedule
    LEFT JOIN content.source_endpoints AS endpoint ON endpoint.endpoint_id = schedule.endpoint_id
    LEFT JOIN content.source_partitions AS partition ON partition.partition_id = schedule.partition_id
    WHERE (
      schedule.endpoint_id IS NOT NULL
      AND (
        endpoint.endpoint_id IS NULL
        OR endpoint.adapter_kind <> schedule.adapter_kind
        OR endpoint.profile_key <> schedule.profile_key
        OR (endpoint.adapter_kind IN ('RSS_ATOM', 'PODCAST_FEED', 'YOUTUBE_CHANNEL') AND schedule.job_kind <> 'FEED_POLL')
        OR endpoint.adapter_kind IN ('X_ACCOUNT', 'X_SEMANTIC')
      )
    ) OR (
      schedule.partition_id IS NOT NULL
      AND (
        partition.partition_id IS NULL
        OR partition.adapter_kind <> schedule.adapter_kind
        OR partition.profile_key <> schedule.profile_key
        OR (partition.adapter_kind = 'X_ACCOUNT' AND schedule.job_kind <> 'X_KEYWORD_SCAN')
        OR (partition.adapter_kind = 'X_SEMANTIC' AND schedule.job_kind <> 'X_SEMANTIC_SCAN')
      )
    )
  ) THEN
    RAISE EXCEPTION 'source schedule must match its target adapter, profile and job kind'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER content_source_schedules_contract
AFTER INSERT OR UPDATE ON content.source_schedules
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION content.assert_source_schedule_contract();

CREATE CONSTRAINT TRIGGER content_source_endpoints_schedule_contract
AFTER UPDATE OF adapter_kind, profile_key ON content.source_endpoints
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION content.assert_source_schedule_contract();

CREATE CONSTRAINT TRIGGER content_source_partitions_schedule_contract
AFTER UPDATE OF adapter_kind, profile_key ON content.source_partitions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION content.assert_source_schedule_contract();

CREATE TABLE content.source_registry_reconciliations (
  reconciliation_id uuid PRIMARY KEY,
  manifest_hash text NOT NULL,
  git_revision text,
  status text NOT NULL,
  entity_count integer NOT NULL DEFAULT 0,
  endpoint_count integer NOT NULL DEFAULT 0,
  partition_count integer NOT NULL DEFAULT 0,
  schedule_count integer NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_summary text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_source_registry_reconciliations_hash_check
    CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT content_source_registry_reconciliations_status_check
    CHECK (status IN ('RUNNING', 'APPLIED', 'UNCHANGED', 'REJECTED')),
  CONSTRAINT content_source_registry_reconciliations_counts_check CHECK (
    entity_count >= 0 AND endpoint_count >= 0 AND partition_count >= 0 AND schedule_count >= 0
  ),
  CONSTRAINT content_source_registry_reconciliations_details_object_check
    CHECK (jsonb_typeof(details) = 'object'),
  CONSTRAINT content_source_registry_reconciliations_completion_check CHECK (
    (status = 'RUNNING' AND completed_at IS NULL)
    OR (status <> 'RUNNING' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX content_source_registry_reconciliations_hash_idx
  ON content.source_registry_reconciliations (manifest_hash, created_at DESC);

CREATE VIEW content.acquisition_endpoint_health
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
  schedule.updated_at
FROM content.source_endpoints AS endpoint
JOIN content.sources AS source ON source.source_id = endpoint.source_id
LEFT JOIN content.source_partition_members AS member ON member.endpoint_id = endpoint.endpoint_id
LEFT JOIN content.source_partitions AS partition ON partition.partition_id = member.partition_id
LEFT JOIN content.source_schedules AS schedule
  ON schedule.endpoint_id = endpoint.endpoint_id
  OR schedule.partition_id = partition.partition_id;

REVOKE ALL ON FUNCTION content.assert_source_partition_contract() FROM PUBLIC;
REVOKE ALL ON FUNCTION content.assert_source_schedule_contract() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION content.assert_source_partition_contract() TO letletme_data_writer;
GRANT EXECUTE ON FUNCTION content.assert_source_schedule_contract() TO letletme_data_writer;

GRANT SELECT, INSERT, UPDATE ON content.source_endpoints TO letletme_data_writer;
GRANT SELECT, INSERT, UPDATE ON content.source_partitions TO letletme_data_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON content.source_partition_members TO letletme_data_writer;
GRANT SELECT, INSERT, UPDATE ON content.source_schedules TO letletme_data_writer;
GRANT SELECT, INSERT, UPDATE ON content.source_registry_reconciliations TO letletme_data_writer;
GRANT SELECT ON content.acquisition_endpoint_health TO letletme_data_writer;
REVOKE DELETE ON content.sources FROM letletme_data_writer;
REVOKE DELETE ON content.source_endpoints FROM letletme_data_writer;
REVOKE DELETE ON content.source_partitions FROM letletme_data_writer;
REVOKE DELETE ON content.source_schedules FROM letletme_data_writer;
REVOKE DELETE ON content.source_registry_reconciliations FROM letletme_data_writer;

REVOKE ALL ON content.source_endpoints FROM letletme_graphql_reader;
REVOKE ALL ON content.source_partitions FROM letletme_graphql_reader;
REVOKE ALL ON content.source_partition_members FROM letletme_graphql_reader;
REVOKE ALL ON content.source_schedules FROM letletme_graphql_reader;
REVOKE ALL ON content.source_registry_reconciliations FROM letletme_graphql_reader;
REVOKE ALL ON content.acquisition_endpoint_health FROM letletme_graphql_reader;

COMMENT ON TABLE content.source_endpoints IS
  'Manifest-managed acquisition endpoints; runtime health and identity are PostgreSQL-authoritative';
COMMENT ON TABLE content.source_schedules IS
  'Durable recurring acquisition schedules claimed with short SKIP LOCKED transactions';
COMMENT ON VIEW content.acquisition_endpoint_health IS
  'Internal acquisition health projection; not exposed to the GraphQL reader';
