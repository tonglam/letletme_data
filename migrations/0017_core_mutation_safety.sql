-- Cross-process mutation coordination and backward-compatible bug report IDs.
--
-- The lock rows are deliberately in PostgreSQL.  A transaction-scoped row lock
-- remains valid when the runtime uses a Supavisor transaction pooler and is
-- released automatically on commit, rollback, or process death.
CREATE TABLE ops.mutation_scopes (
  scope_key text PRIMARY KEY,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mutation_scopes_key_nonempty CHECK (btrim(scope_key) <> ''::text)
);

ALTER TABLE ops.mutation_scopes OWNER TO letletme_data_owner;
GRANT SELECT, INSERT, UPDATE ON TABLE ops.mutation_scopes TO letletme_data_writer;
REVOKE DELETE ON TABLE ops.mutation_scopes FROM letletme_data_writer;
REVOKE ALL ON TABLE ops.mutation_scopes FROM letletme_graphql_reader;

ALTER TABLE ops.bug_reports DROP CONSTRAINT bug_reports_public_id_format;
ALTER TABLE ops.bug_reports
  ADD CONSTRAINT bug_reports_public_id_format
  CHECK (public_id ~ '^LL-([0-9A-F]{6}|[0-9A-F]{12})$'::text);
