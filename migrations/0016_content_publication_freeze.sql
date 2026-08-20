-- Immutable editorial freeze and publication command bookkeeping.
--
-- A READY edition is a one-way boundary.  The JSON snapshot is intentionally
-- self-contained: publication compilation never needs to read mutable Story,
-- evidence or source rows after READY.

ALTER TABLE content.week_editions
  ADD COLUMN ready_at timestamptz,
  ADD COLUMN published_at timestamptz,
  ADD COLUMN published_publication_id uuid,
  ADD COLUMN frozen_sha256 text;

ALTER TABLE content.acquisition_runs
  ADD COLUMN source_snapshot_revision text;

ALTER TABLE content.week_editions
  ADD CONSTRAINT content_week_editions_frozen_sha_check
  CHECK (frozen_sha256 IS NULL OR frozen_sha256 ~ '^[0-9a-f]{64}$');

CREATE TABLE content.week_edition_source_runs (
  edition_id uuid NOT NULL REFERENCES content.week_editions(edition_id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES content.acquisition_runs(run_id) ON DELETE RESTRICT,
  source_snapshot_revision text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (edition_id, run_id)
);

CREATE TABLE content.week_edition_snapshots (
  snapshot_id uuid PRIMARY KEY,
  edition_id uuid NOT NULL UNIQUE REFERENCES content.week_editions(edition_id) ON DELETE RESTRICT,
  source_run_ids jsonb NOT NULL,
  source_snapshot_revision text NOT NULL,
  event_projection jsonb NOT NULL,
  items_projection jsonb NOT NULL,
  frozen_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_week_edition_snapshots_source_runs_array_check
    CHECK (jsonb_typeof(source_run_ids) = 'array'),
  CONSTRAINT content_week_edition_snapshots_event_object_check
    CHECK (jsonb_typeof(event_projection) = 'object'),
  CONSTRAINT content_week_edition_snapshots_items_array_check
    CHECK (jsonb_typeof(items_projection) = 'array'),
  CONSTRAINT content_week_edition_snapshots_sha_check
    CHECK (frozen_sha256 ~ '^[0-9a-f]{64}$')
);

ALTER TABLE content.editorial_actions
  ADD COLUMN request_hash text,
  ADD COLUMN result_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN completed_at timestamptz;

ALTER TABLE content.editorial_actions
  ADD CONSTRAINT content_editorial_actions_request_hash_check
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT content_editorial_actions_result_payload_check
    CHECK (jsonb_typeof(result_payload) = 'object');

CREATE INDEX content_week_edition_source_runs_run_idx
  ON content.week_edition_source_runs (run_id, created_at DESC);
CREATE INDEX content_week_edition_snapshots_edition_idx
  ON content.week_edition_snapshots (edition_id, created_at DESC);
CREATE INDEX content_editorial_actions_request_hash_idx
  ON content.editorial_actions (request_hash, created_at DESC);

-- Do not allow an immutable READY edition's item projection to be changed by
-- direct SQL or an application bug.  These are invoker-security trigger
-- functions; they are not exposed as public RPC helpers.
CREATE OR REPLACE FUNCTION content.assert_draft_week_edition_items()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = content, pg_catalog
AS $$
DECLARE
  edition_status text;
BEGIN
  SELECT status INTO edition_status
  FROM content.week_editions
  WHERE edition_id = COALESCE(NEW.edition_id, OLD.edition_id);
  IF edition_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Week edition items are immutable after READY' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER content_week_edition_items_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON content.week_edition_items
  FOR EACH ROW EXECUTE FUNCTION content.assert_draft_week_edition_items();

CREATE OR REPLACE FUNCTION content.assert_draft_story_localization()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = content, pg_catalog
AS $$
DECLARE
  story_status text;
  version_group uuid := COALESCE(NEW.version_group_id, OLD.version_group_id);
BEGIN
  SELECT status INTO story_status
  FROM content.stories
  WHERE version_group_id = version_group
  ORDER BY story_revision DESC
  LIMIT 1;
  IF story_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Story localization is immutable after READY' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER content_story_localizations_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON content.story_localizations
  FOR EACH ROW EXECUTE FUNCTION content.assert_draft_story_localization();

CREATE OR REPLACE FUNCTION content.assert_draft_story_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = content, pg_catalog
AS $$
DECLARE
  story_status text;
  story_key uuid := COALESCE(NEW.story_id, OLD.story_id);
BEGIN
  SELECT status INTO story_status FROM content.stories WHERE story_id = story_key;
  IF story_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Story evidence is immutable after READY' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER content_story_evidence_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON content.story_evidence
  FOR EACH ROW EXECUTE FUNCTION content.assert_draft_story_evidence();

CREATE OR REPLACE FUNCTION content.prevent_week_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = content, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Week edition snapshots are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER content_week_edition_snapshots_immutable
  BEFORE UPDATE OR DELETE ON content.week_edition_snapshots
  FOR EACH ROW EXECUTE FUNCTION content.prevent_week_snapshot_mutation();

REVOKE ALL ON FUNCTION content.assert_draft_week_edition_items() FROM PUBLIC;
REVOKE ALL ON FUNCTION content.assert_draft_story_localization() FROM PUBLIC;
REVOKE ALL ON FUNCTION content.assert_draft_story_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION content.prevent_week_snapshot_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION content.assert_draft_week_edition_items() TO letletme_data_writer;
GRANT EXECUTE ON FUNCTION content.assert_draft_story_localization() TO letletme_data_writer;
GRANT EXECUTE ON FUNCTION content.assert_draft_story_evidence() TO letletme_data_writer;
GRANT EXECUTE ON FUNCTION content.prevent_week_snapshot_mutation() TO letletme_data_writer;

GRANT USAGE ON SCHEMA content TO letletme_data_writer;
GRANT SELECT, INSERT ON content.week_edition_source_runs TO letletme_data_writer;
GRANT SELECT, INSERT ON content.week_edition_snapshots TO letletme_data_writer;
REVOKE UPDATE, DELETE ON content.week_edition_source_runs FROM letletme_data_writer;
REVOKE UPDATE, DELETE ON content.week_edition_snapshots FROM letletme_data_writer;
GRANT SELECT ON content.week_edition_snapshots TO letletme_graphql_reader;
GRANT SELECT ON content.publications TO letletme_graphql_reader;

ALTER DEFAULT PRIVILEGES FOR ROLE letletme_data_owner IN SCHEMA content
  GRANT SELECT, INSERT ON TABLES TO letletme_data_writer;
