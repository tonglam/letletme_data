-- Mark a report whose body and identity were scrubbed before a remote
-- screenshot deletion completed. The marker prevents a user-authored body
-- from being confused with the cleanup sentinel during status transitions.

ALTER TABLE ops.bug_reports
  ADD COLUMN IF NOT EXISTS scrubbed_at timestamptz;

-- The previous cleanup implementation used the body sentinel before this
-- column existed. Recover only rows that also have the durable screenshot
-- retention inventory created by that cleanup path; a user-authored body
-- alone must never be treated as a scrub marker.
UPDATE ops.bug_reports AS report
SET scrubbed_at = COALESCE(
  backup.screenshot_delete_started_at,
  backup.screenshot_deleted_at,
  backup.backed_up_at,
  report.created_at
)
FROM ops.bug_report_retention_backups AS backup
WHERE report.scrubbed_at IS NULL
  AND backup.id = report.id
  AND report.body = 'Screenshot cleanup pending.'
  AND report.screenshot_url IS NULL
  AND report.user_id IS NULL
  AND report.entry_id IS NULL
  AND report.client_meta = '{}'::jsonb
  AND backup.snapshot ? 'screenshotUrl';

COMMENT ON COLUMN ops.bug_reports.scrubbed_at IS
  'Timestamp at which retention scrubbed report content before remote screenshot deletion completed.';
