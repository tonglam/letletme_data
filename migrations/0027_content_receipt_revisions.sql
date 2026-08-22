-- Stable Receipt identity, immutable factual revisions, transcript segments, observations and the
-- first-layer outbox. Existing Receipt rows are retained as legacy revision-zero compatibility
-- records; all new downstream consumers read source_receipt_revisions.

ALTER TABLE content.source_receipts
  ADD COLUMN receipt_key text,
  ADD COLUMN primary_endpoint_id uuid REFERENCES content.source_endpoints(endpoint_id) ON DELETE RESTRICT,
  ADD COLUMN content_kind text NOT NULL DEFAULT 'POST',
  ADD COLUMN current_revision_id uuid;

UPDATE content.source_receipts
SET receipt_key = 'legacy-' || replace(source_id::text, '-', '') || '-' || md5(external_id)
WHERE receipt_key IS NULL;

ALTER TABLE content.source_receipts
  ALTER COLUMN receipt_key SET NOT NULL,
  ALTER COLUMN canonical_url DROP NOT NULL,
  DROP CONSTRAINT source_receipts_run_id_fkey,
  ADD CONSTRAINT source_receipts_run_id_fkey
    FOREIGN KEY (run_id) REFERENCES content.acquisition_runs(run_id) ON DELETE RESTRICT,
  ADD CONSTRAINT content_source_receipts_receipt_key_key UNIQUE (receipt_key),
  ADD CONSTRAINT content_source_receipts_content_kind_check
    CHECK (content_kind IN ('POST', 'ARTICLE', 'EPISODE', 'VIDEO')),
  ADD CONSTRAINT content_source_receipts_formal_endpoint_check
    CHECK (receipt_key LIKE 'legacy-%' OR primary_endpoint_id IS NOT NULL);

CREATE INDEX content_source_receipts_endpoint_idx
  ON content.source_receipts (primary_endpoint_id, created_at DESC)
  WHERE primary_endpoint_id IS NOT NULL;

CREATE TABLE content.source_receipt_revisions (
  receipt_revision_id uuid PRIMARY KEY,
  receipt_id uuid NOT NULL REFERENCES content.source_receipts(receipt_id) ON DELETE RESTRICT,
  revision_number integer NOT NULL,
  run_id uuid NOT NULL REFERENCES content.acquisition_runs(run_id) ON DELETE RESTRICT,
  endpoint_id uuid NOT NULL REFERENCES content.source_endpoints(endpoint_id) ON DELETE RESTRICT,
  payload jsonb NOT NULL,
  canonical_hash text NOT NULL,
  body_availability text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_source_receipt_revisions_number_check CHECK (revision_number >= 1),
  CONSTRAINT content_source_receipt_revisions_payload_object_check
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT content_source_receipt_revisions_hash_check
    CHECK (canonical_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT content_source_receipt_revisions_body_check
    CHECK (body_availability IN ('FULL', 'EXCERPT', 'METADATA_ONLY')),
  CONSTRAINT content_source_receipt_revisions_receipt_number_key
    UNIQUE (receipt_id, revision_number),
  CONSTRAINT content_source_receipt_revisions_run_receipt_key UNIQUE (run_id, receipt_id)
);

ALTER TABLE content.source_receipts
  ADD CONSTRAINT content_source_receipts_current_revision_fkey
  FOREIGN KEY (current_revision_id)
  REFERENCES content.source_receipt_revisions(receipt_revision_id)
  ON DELETE RESTRICT;

CREATE INDEX content_source_receipt_revisions_receipt_created_idx
  ON content.source_receipt_revisions (receipt_id, created_at DESC);
CREATE INDEX content_source_receipt_revisions_endpoint_created_idx
  ON content.source_receipt_revisions (endpoint_id, created_at DESC);

CREATE TABLE content.source_transcript_revisions (
  transcript_revision_id uuid PRIMARY KEY,
  receipt_revision_id uuid NOT NULL
    REFERENCES content.source_receipt_revisions(receipt_revision_id) ON DELETE RESTRICT,
  transcript_revision_number integer NOT NULL,
  status text NOT NULL,
  provider text,
  engine text,
  model_revision text,
  options_revision text,
  language text,
  track_kind text,
  media_hash text,
  segments_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_source_transcript_revisions_number_check
    CHECK (transcript_revision_number >= 1),
  CONSTRAINT content_source_transcript_revisions_status_check CHECK (
    status IN ('PROVIDED', 'GENERATED', 'UNAVAILABLE', 'DEFERRED', 'FAILED')
  ),
  CONSTRAINT content_source_transcript_revisions_track_check
    CHECK (track_kind IS NULL OR track_kind IN ('MANUAL', 'AUTO', 'UNKNOWN')),
  CONSTRAINT content_source_transcript_revisions_media_hash_check
    CHECK (media_hash IS NULL OR media_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT content_source_transcript_revisions_segments_hash_check
    CHECK (segments_hash IS NULL OR segments_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT content_source_transcript_revisions_receipt_number_key
    UNIQUE (receipt_revision_id, transcript_revision_number)
);

CREATE TABLE content.source_transcript_segments (
  transcript_revision_id uuid NOT NULL
    REFERENCES content.source_transcript_revisions(transcript_revision_id) ON DELETE RESTRICT,
  ordinal integer NOT NULL,
  start_ms integer NOT NULL,
  end_ms integer NOT NULL,
  normalized_text text NOT NULL,
  segment_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transcript_revision_id, ordinal),
  CONSTRAINT content_source_transcript_segments_ordinal_check CHECK (ordinal >= 0),
  CONSTRAINT content_source_transcript_segments_time_check
    CHECK (start_ms >= 0 AND end_ms > start_ms),
  CONSTRAINT content_source_transcript_segments_text_check CHECK (btrim(normalized_text) <> ''),
  CONSTRAINT content_source_transcript_segments_hash_check
    CHECK (segment_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX content_source_transcript_segments_hash_idx
  ON content.source_transcript_segments (segment_hash);

CREATE TABLE content.source_observations (
  observation_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES content.acquisition_runs(run_id) ON DELETE RESTRICT,
  endpoint_id uuid NOT NULL REFERENCES content.source_endpoints(endpoint_id) ON DELETE RESTRICT,
  external_item_id text NOT NULL,
  receipt_id uuid REFERENCES content.source_receipts(receipt_id) ON DELETE RESTRICT,
  receipt_revision_id uuid
    REFERENCES content.source_receipt_revisions(receipt_revision_id) ON DELETE RESTRICT,
  outcome text NOT NULL,
  native_item_hash text,
  reason_code text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_source_observations_outcome_check CHECK (
    outcome IN ('ACCEPTED', 'UNCHANGED', 'REJECTED', 'BOOTSTRAP_OUT_OF_SCOPE')
  ),
  CONSTRAINT content_source_observations_hash_check
    CHECK (native_item_hash IS NULL OR native_item_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT content_source_observations_receipt_pair_check CHECK (
    (receipt_revision_id IS NULL)
    OR (receipt_id IS NOT NULL AND receipt_revision_id IS NOT NULL)
  ),
  CONSTRAINT content_source_observations_accepted_receipt_check CHECK (
    outcome NOT IN ('ACCEPTED', 'UNCHANGED') OR receipt_id IS NOT NULL
  ),
  CONSTRAINT content_source_observations_run_item_key
    UNIQUE (run_id, endpoint_id, external_item_id)
);

CREATE INDEX content_source_observations_receipt_idx
  ON content.source_observations (receipt_id, observed_at DESC)
  WHERE receipt_id IS NOT NULL;
CREATE INDEX content_source_observations_endpoint_idx
  ON content.source_observations (endpoint_id, observed_at DESC);

CREATE TABLE content.pipeline_outbox (
  outbox_id uuid PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  event_type text NOT NULL,
  receipt_id uuid NOT NULL REFERENCES content.source_receipts(receipt_id) ON DELETE RESTRICT,
  receipt_revision_id uuid NOT NULL
    REFERENCES content.source_receipt_revisions(receipt_revision_id) ON DELETE RESTRICT,
  run_id uuid NOT NULL REFERENCES content.acquisition_runs(run_id) ON DELETE RESTRICT,
  source_id uuid NOT NULL REFERENCES content.sources(source_id) ON DELETE RESTRICT,
  endpoint_id uuid NOT NULL REFERENCES content.source_endpoints(endpoint_id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  available_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  last_error_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_pipeline_outbox_event_type_check
    CHECK (event_type IN ('receipt.accepted.v1', 'receipt.updated.v1')),
  CONSTRAINT content_pipeline_outbox_payload_object_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT content_pipeline_outbox_status_check
    CHECK (status IN ('PENDING', 'DELIVERED')),
  CONSTRAINT content_pipeline_outbox_attempt_check CHECK (attempt_count >= 0),
  CONSTRAINT content_pipeline_outbox_lease_check CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT content_pipeline_outbox_delivery_check CHECK (
    (status = 'PENDING' AND delivered_at IS NULL)
    OR (status = 'DELIVERED' AND delivered_at IS NOT NULL)
  )
);

CREATE INDEX content_pipeline_outbox_pending_idx
  ON content.pipeline_outbox (available_at, outbox_id)
  WHERE status = 'PENDING' AND lease_expires_at IS NULL;
CREATE INDEX content_pipeline_outbox_reclaim_idx
  ON content.pipeline_outbox (lease_expires_at, outbox_id)
  WHERE status = 'PENDING' AND lease_expires_at IS NOT NULL;

CREATE OR REPLACE FUNCTION content.prevent_immutable_acquisition_fact_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = content, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER content_source_receipt_revisions_immutable
BEFORE UPDATE OR DELETE ON content.source_receipt_revisions
FOR EACH ROW EXECUTE FUNCTION content.prevent_immutable_acquisition_fact_mutation();
CREATE TRIGGER content_source_transcript_revisions_immutable
BEFORE UPDATE OR DELETE ON content.source_transcript_revisions
FOR EACH ROW EXECUTE FUNCTION content.prevent_immutable_acquisition_fact_mutation();
CREATE TRIGGER content_source_transcript_segments_immutable
BEFORE UPDATE OR DELETE ON content.source_transcript_segments
FOR EACH ROW EXECUTE FUNCTION content.prevent_immutable_acquisition_fact_mutation();
CREATE TRIGGER content_source_observations_immutable
BEFORE UPDATE OR DELETE ON content.source_observations
FOR EACH ROW EXECUTE FUNCTION content.prevent_immutable_acquisition_fact_mutation();

CREATE OR REPLACE FUNCTION content.assert_pipeline_outbox_payload()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = content, pg_catalog
AS $$
BEGIN
  IF NOT (
    NEW.payload ?& ARRAY[
      'receiptId',
      'receiptRevisionId',
      'runId',
      'sourceId',
      'endpointId',
      'occurredAt'
    ]
    AND NEW.payload - ARRAY[
      'receiptId',
      'receiptRevisionId',
      'runId',
      'sourceId',
      'endpointId',
      'occurredAt'
    ] = '{}'::jsonb
  ) THEN
    RAISE EXCEPTION 'pipeline outbox payload may contain only the stable receipt event envelope'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER content_pipeline_outbox_payload_contract
BEFORE INSERT OR UPDATE OF payload ON content.pipeline_outbox
FOR EACH ROW EXECUTE FUNCTION content.assert_pipeline_outbox_payload();

REVOKE ALL ON FUNCTION content.prevent_immutable_acquisition_fact_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION content.assert_pipeline_outbox_payload() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION content.prevent_immutable_acquisition_fact_mutation()
  TO letletme_data_writer;
GRANT EXECUTE ON FUNCTION content.assert_pipeline_outbox_payload() TO letletme_data_writer;

GRANT SELECT, INSERT, UPDATE ON content.source_receipts TO letletme_data_writer;
GRANT SELECT, INSERT ON content.source_receipt_revisions TO letletme_data_writer;
GRANT SELECT, INSERT ON content.source_transcript_revisions TO letletme_data_writer;
GRANT SELECT, INSERT ON content.source_transcript_segments TO letletme_data_writer;
GRANT SELECT, INSERT ON content.source_observations TO letletme_data_writer;
GRANT SELECT, INSERT, UPDATE ON content.pipeline_outbox TO letletme_data_writer;
REVOKE DELETE ON content.source_receipts FROM letletme_data_writer;
REVOKE UPDATE, DELETE ON content.source_receipt_revisions FROM letletme_data_writer;
REVOKE UPDATE, DELETE ON content.source_transcript_revisions FROM letletme_data_writer;
REVOKE UPDATE, DELETE ON content.source_transcript_segments FROM letletme_data_writer;
REVOKE UPDATE, DELETE ON content.source_observations FROM letletme_data_writer;
REVOKE DELETE ON content.pipeline_outbox FROM letletme_data_writer;

REVOKE ALL ON content.source_receipt_revisions FROM letletme_graphql_reader;
REVOKE ALL ON content.source_transcript_revisions FROM letletme_graphql_reader;
REVOKE ALL ON content.source_transcript_segments FROM letletme_graphql_reader;
REVOKE ALL ON content.source_observations FROM letletme_graphql_reader;
REVOKE ALL ON content.pipeline_outbox FROM letletme_graphql_reader;

COMMENT ON TABLE content.source_receipt_revisions IS
  'Immutable canonical source facts; downstream Candidate processing reads revision IDs only';
COMMENT ON TABLE content.pipeline_outbox IS
  'Atomic first-layer events containing IDs only; no article, post or transcript text';
