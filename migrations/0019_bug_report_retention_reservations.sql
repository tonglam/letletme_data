-- Preserve private screenshot submission/key reservations after report-body
-- retention and index both pending and completed screenshot tombstones.

ALTER TABLE ops.bug_report_retention_backups
  ADD COLUMN IF NOT EXISTS submission_id uuid;

-- Older private inventories encode the submission UUID in their validated key.
-- Recover it before adding the partial reservation index; malformed historical
-- rows remain null and are still handled by the object-key index when present.
UPDATE ops.bug_report_retention_backups
SET submission_id = substring(
  lower(screenshot_object_key)
  FROM '^bug-reports/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(jpg|png|webp|gif)$'
)::uuid
WHERE submission_id IS NULL
  AND screenshot_object_key IS NOT NULL
  AND lower(screenshot_object_key) ~ '^bug-reports/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp|gif)$';

CREATE UNIQUE INDEX IF NOT EXISTS bug_report_retention_backups_submission_id_key
  ON ops.bug_report_retention_backups (submission_id)
  WHERE submission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS bug_report_retention_backups_private_key_idx
  ON ops.bug_report_retention_backups (screenshot_object_key)
  WHERE screenshot_object_key IS NOT NULL AND screenshot_deleted_at IS NULL;

DROP INDEX IF EXISTS ops.bug_report_retention_backups_screenshot_tombstone_idx;

CREATE INDEX IF NOT EXISTS bug_report_retention_backups_screenshot_tombstone_idx
  ON ops.bug_report_retention_backups ((snapshot->>'screenshotUrl'))
  WHERE screenshot_delete_started_at IS NOT NULL OR screenshot_deleted_at IS NOT NULL;

COMMENT ON COLUMN ops.bug_report_retention_backups.submission_id IS
  'Retained submission reservation; kept after report-body scrubbing so retries cannot reuse expired private screenshot identities.';
