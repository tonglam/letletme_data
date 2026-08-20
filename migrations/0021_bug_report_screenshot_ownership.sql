-- A private screenshot key is owned by the submission UUID embedded in its
-- path.  Keep that binding in PostgreSQL and prevent two reports from claiming
-- the same storage object.

ALTER TABLE ops.bug_reports
    DROP CONSTRAINT IF EXISTS bug_reports_screenshot_object_key_format;

ALTER TABLE ops.bug_reports
    ADD CONSTRAINT bug_reports_screenshot_object_key_format
    CHECK (
        screenshot_object_key IS NULL OR (
            submission_id IS NOT NULL AND
            screenshot_object_key ~* ('^bug-reports/' || submission_id::text || '\.(jpg|png|webp|gif)$')
        )
    );

CREATE UNIQUE INDEX IF NOT EXISTS bug_reports_screenshot_object_key_key
    ON ops.bug_reports (screenshot_object_key)
    WHERE screenshot_object_key IS NOT NULL;
