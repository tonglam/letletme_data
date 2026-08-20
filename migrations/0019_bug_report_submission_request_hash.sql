-- Preserve the normalized request identity behind submission-id idempotency.
-- Existing rows remain nullable and are backfilled lazily on an exact replay.

ALTER TABLE ops.bug_reports
  ADD COLUMN IF NOT EXISTS submission_request_hash text;

ALTER TABLE ops.bug_reports
  ADD CONSTRAINT bug_reports_submission_request_hash_format
  CHECK (
    submission_request_hash IS NULL OR
    submission_request_hash ~ '^[0-9a-f]{64}$'
  );

CREATE INDEX IF NOT EXISTS bug_reports_submission_request_hash_idx
  ON ops.bug_reports (submission_request_hash)
  WHERE submission_request_hash IS NOT NULL;

COMMENT ON COLUMN ops.bug_reports.submission_request_hash IS
  'Canonical hash of the normalized create request used for submission-id replay safety.';
