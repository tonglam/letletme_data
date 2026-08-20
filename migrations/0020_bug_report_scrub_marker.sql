-- Mark a report whose body and identity were scrubbed before a remote
-- screenshot deletion completed. The marker prevents a user-authored body
-- from being confused with the cleanup sentinel during status transitions.

ALTER TABLE ops.bug_reports
  ADD COLUMN IF NOT EXISTS scrubbed_at timestamptz;

COMMENT ON COLUMN ops.bug_reports.scrubbed_at IS
  'Timestamp at which retention scrubbed report content before remote screenshot deletion completed.';
