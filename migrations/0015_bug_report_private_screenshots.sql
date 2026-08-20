-- Expand bug-report screenshot storage for the private, key-only lifecycle.
-- The legacy screenshot_url column remains during the seven-day rollback window.

ALTER TABLE ops.bug_reports
    ADD COLUMN IF NOT EXISTS submission_id uuid,
    ADD COLUMN IF NOT EXISTS screenshot_object_key text,
    ADD COLUMN IF NOT EXISTS screenshot_deleted_at timestamp with time zone;

CREATE UNIQUE INDEX IF NOT EXISTS bug_reports_submission_id_key
    ON ops.bug_reports (submission_id);

CREATE INDEX IF NOT EXISTS bug_reports_screenshot_retention_idx
    ON ops.bug_reports (created_at ASC)
    WHERE screenshot_object_key IS NOT NULL AND screenshot_deleted_at IS NULL;

ALTER TABLE ops.bug_reports
    ADD CONSTRAINT bug_reports_screenshot_input_exclusive
    CHECK (NOT (screenshot_url IS NOT NULL AND screenshot_object_key IS NOT NULL));

ALTER TABLE ops.bug_reports
    ADD CONSTRAINT bug_reports_screenshot_object_key_format
    CHECK (
        screenshot_object_key IS NULL OR (
            submission_id IS NOT NULL AND
            COALESCE(
                substring(lower(screenshot_object_key) FROM '^bug-reports/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(jpg|png|webp|gif)$') = lower(submission_id::text),
                false
            )
        )
    );

COMMENT ON COLUMN ops.bug_reports.submission_id IS
    'Client-generated idempotency key for a report submission.';
COMMENT ON COLUMN ops.bug_reports.screenshot_object_key IS
    'Private Supabase Storage object key; never expose a public URL.';
COMMENT ON COLUMN ops.bug_reports.screenshot_deleted_at IS
    'Timestamp at which the private screenshot was successfully removed or confirmed absent.';
