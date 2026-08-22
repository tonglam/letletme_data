-- Relationally bind triggered content jobs to the immutable ReceiptRevision that caused them.
-- Queue payloads remain runId-only; this target is used for deduplication and unattended retries.

ALTER TABLE content.acquisition_runs
  ADD COLUMN target_receipt_id uuid
    REFERENCES content.source_receipts(receipt_id) ON DELETE RESTRICT,
  ADD COLUMN target_receipt_revision_id uuid
    REFERENCES content.source_receipt_revisions(receipt_revision_id) ON DELETE RESTRICT,
  ADD CONSTRAINT content_acquisition_runs_target_receipt_pair_check CHECK (
    (target_receipt_id IS NULL AND target_receipt_revision_id IS NULL)
    OR (target_receipt_id IS NOT NULL AND target_receipt_revision_id IS NOT NULL)
  );

CREATE INDEX content_acquisition_runs_target_receipt_idx
  ON content.acquisition_runs (target_receipt_id, created_at DESC)
  WHERE target_receipt_id IS NOT NULL;

CREATE UNIQUE INDEX content_acquisition_runs_active_content_target_idx
  ON content.acquisition_runs (job_kind, target_receipt_id)
  WHERE target_receipt_id IS NOT NULL
    AND job_kind IN ('ARTICLE_FETCH', 'PODCAST_TRANSCRIPT', 'YOUTUBE_METADATA', 'YOUTUBE_TRANSCRIPT')
    AND status IN ('PENDING', 'RUNNING');

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
    OR NEW.target_receipt_id IS DISTINCT FROM OLD.target_receipt_id
    OR NEW.target_receipt_revision_id IS DISTINCT FROM OLD.target_receipt_revision_id
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

REVOKE ALL ON FUNCTION content.prevent_formal_acquisition_request_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION content.prevent_formal_acquisition_request_mutation()
  TO letletme_data_writer;

COMMENT ON COLUMN content.acquisition_runs.target_receipt_revision_id IS
  'Immutable ReceiptRevision that caused a triggered article, transcript, or metadata job';
