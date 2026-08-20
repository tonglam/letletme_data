-- Bug report retention and status lifecycle.
-- Existing rows that already exceeded 180 days receive a one-time seven-day
-- migration grace period; new and changed rows are governed by the service.

ALTER TABLE ops.bug_reports
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

UPDATE ops.bug_reports
SET expires_at = CASE
  WHEN created_at + interval '180 days' <= now()
    THEN now() + interval '7 days'
  ELSE created_at + interval '180 days'
END
WHERE expires_at IS NULL;

ALTER TABLE ops.bug_reports
  ALTER COLUMN expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS bug_reports_expiry_idx
  ON ops.bug_reports (expires_at ASC);

CREATE TABLE IF NOT EXISTS ops.bug_report_retention_backups (
  id uuid PRIMARY KEY,
  public_id text NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now(),
  snapshot jsonb NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS bug_report_retention_backups_public_id_key
  ON ops.bug_report_retention_backups (public_id);

CREATE INDEX IF NOT EXISTS bug_report_retention_backups_created_idx
  ON ops.bug_report_retention_backups (backed_up_at DESC);

CREATE TABLE IF NOT EXISTS ops.bug_report_storage_migrations (
  id uuid PRIMARY KEY,
  public_id text NOT NULL,
  source_locator text NOT NULL,
  target_locator text NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT bug_report_storage_migrations_source_https
    CHECK (source_locator ~ '^https://'::text),
  CONSTRAINT bug_report_storage_migrations_target_https
    CHECK (target_locator ~ '^https://'::text)
);

CREATE UNIQUE INDEX IF NOT EXISTS bug_report_storage_migrations_source_key
  ON ops.bug_report_storage_migrations (source_locator);

CREATE INDEX IF NOT EXISTS bug_report_storage_migrations_pending_idx
  ON ops.bug_report_storage_migrations (deleted_at, migrated_at);

-- The cleanup job must be able to remove a row only after its screenshot has
-- been deleted, and must retain a durable inventory of migrated objects.
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ops.bug_reports TO letletme_data_writer;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ops.bug_report_retention_backups TO letletme_data_writer;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ops.bug_report_storage_migrations TO letletme_data_writer;

COMMENT ON COLUMN ops.bug_reports.expires_at IS
  'Retention deadline. New rows are created_at + 180 days; closed rows may shorten to closed_at + 30 days.';
