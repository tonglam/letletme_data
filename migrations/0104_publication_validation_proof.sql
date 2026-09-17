BEGIN;

SET LOCAL lock_timeout = '5s';

-- NULL means that the historical row has not passed the new producer-side
-- proof boundary. New writers set version 1 only in the same transaction as
-- the complete payload and its identity metadata. Keeping these columns
-- nullable avoids rewriting every historical JSONB row during the additive
-- rollout; the application treats NULL and zero as unproved.
ALTER TABLE competition.live_league_checkpoints
  ADD COLUMN validation_version integer;

ALTER TABLE competition.live_league_checkpoints
  ADD CONSTRAINT live_league_checkpoints_validation_version_check
  CHECK (validation_version IS NULL OR validation_version >= 0);

ALTER TABLE ops.dataset_publications
  ADD COLUMN validation_version integer;

ALTER TABLE ops.dataset_publications
  ADD CONSTRAINT dataset_publications_validation_version_check
  CHECK (validation_version IS NULL OR validation_version >= 0);

ALTER TABLE ops.dataset_publication_items
  ADD COLUMN validation_version integer;

ALTER TABLE ops.dataset_publication_items
  ADD CONSTRAINT dataset_publication_items_validation_version_check
  CHECK (validation_version IS NULL OR validation_version >= 0);

ALTER TABLE competition.live_points_publication_checkpoints
  ADD COLUMN validation_version integer;

ALTER TABLE competition.live_points_publication_checkpoints
  ADD CONSTRAINT live_points_publication_checkpoints_validation_version_check
  CHECK (validation_version IS NULL OR validation_version >= 0);

-- A cutover can commit the Live Points stage and fail before the Live Matches
-- stage (or be interrupted after either stage). Keep that state in a tiny
-- durable row so the next deployment resumes the explicit all-finalized
-- scope automatically instead of inferring completion from a process exit or
-- from the SQL migration ledger alone.
CREATE TABLE ops.live_publication_cutover_status (
  season_id smallint NOT NULL,
  scope_kind text NOT NULL,
  event_id integer NOT NULL DEFAULT 0,
  live_points_completed_at timestamptz,
  live_matches_completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT live_publication_cutover_status_pkey
    PRIMARY KEY (season_id, scope_kind, event_id),
  CONSTRAINT live_publication_cutover_status_season_fk
    FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id),
  CONSTRAINT live_publication_cutover_status_scope_check
    CHECK (
      (scope_kind = 'all_finalized' AND event_id = 0)
      OR (scope_kind = 'event' AND event_id > 0)
    ),
  CONSTRAINT live_publication_cutover_status_completion_order_check
    CHECK (
      live_matches_completed_at IS NULL
      OR live_points_completed_at IS NOT NULL
    )
);

REVOKE ALL ON TABLE ops.live_publication_cutover_status FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE ops.live_publication_cutover_status
  TO letletme_data_writer;
GRANT SELECT ON TABLE ops.live_publication_cutover_status
  TO letletme_graphql_reader;

-- Application locks and semantic checks are the normal write boundary. Keep a
-- database fence as well so a direct writer cannot replace or delete a
-- payload after it has been marked as validated. Retiring a dataset
-- publication remains allowed; its retired items may then be cascaded away.
CREATE OR REPLACE FUNCTION ops.prevent_validated_publication_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, competition, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.validation_version IS NOT NULL
    AND (
      NEW.validation_version IS NULL
      OR NEW.validation_version < OLD.validation_version
    ) THEN
    RAISE EXCEPTION 'publication validation proof cannot move backwards' USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.validation_version >= 1 THEN
    -- Keep each table's record fields inside its own branch. PL/pgSQL resolves
    -- NEW/OLD record fields when the branch expression is compiled; combining
    -- table-specific fields with an `AND TG_TABLE_NAME = ...` guard still
    -- raises "record NEW has no field" on the other tables.
    IF TG_TABLE_NAME = 'dataset_publication_items' THEN
      IF NEW.publication_id IS DISTINCT FROM OLD.publication_id OR
        NEW.item_name IS DISTINCT FROM OLD.item_name OR
        NEW.payload IS DISTINCT FROM OLD.payload OR
        NEW.item_count IS DISTINCT FROM OLD.item_count OR
        NEW.checksum IS DISTINCT FROM OLD.checksum
      THEN
        RAISE EXCEPTION 'validated publication item is immutable' USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'dataset_publications' THEN
      IF NEW.publication_id IS DISTINCT FROM OLD.publication_id OR
        NEW.dataset IS DISTINCT FROM OLD.dataset OR
        NEW.season_id IS DISTINCT FROM OLD.season_id OR
        NEW.event_id IS DISTINCT FROM OLD.event_id OR
        NEW.revision IS DISTINCT FROM OLD.revision OR
        NEW.manifest IS DISTINCT FROM OLD.manifest
      THEN
        RAISE EXCEPTION 'validated publication identity is immutable' USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'live_points_publication_checkpoints' THEN
      IF NEW.season_id IS DISTINCT FROM OLD.season_id OR
        NEW.event_id IS DISTINCT FROM OLD.event_id
      THEN
        RAISE EXCEPTION 'validated live points checkpoint scope is immutable' USING ERRCODE = '55000';
      END IF;
      IF NEW.publication_id IS NOT DISTINCT FROM OLD.publication_id AND (
        NEW.generation IS DISTINCT FROM OLD.generation OR
        NEW.state IS DISTINCT FROM OLD.state OR
        NEW.published_at IS DISTINCT FROM OLD.published_at OR
        NEW.revisions IS DISTINCT FROM OLD.revisions OR
        NEW.event_live IS DISTINCT FROM OLD.event_live OR
        NEW.fixtures IS DISTINCT FROM OLD.fixtures OR
        NEW.event_live_bytes IS DISTINCT FROM OLD.event_live_bytes OR
        NEW.fixtures_bytes IS DISTINCT FROM OLD.fixtures_bytes OR
        NEW.event_live_sha256 IS DISTINCT FROM OLD.event_live_sha256 OR
        NEW.fixtures_sha256 IS DISTINCT FROM OLD.fixtures_sha256 OR
        NEW.event_live_count IS DISTINCT FROM OLD.event_live_count OR
        NEW.fixtures_count IS DISTINCT FROM OLD.fixtures_count
      ) THEN
        RAISE EXCEPTION 'validated live points checkpoint is immutable' USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'live_league_checkpoints' THEN
      -- A marker retry may refresh checkpointedAt after the durable row
      -- committed. Provisional rows also refresh the two bounded heartbeat
      -- fields between observations; every other manifest field remains
      -- immutable, so a same-identity retry cannot replace its proof.
      IF NEW.season_id IS DISTINCT FROM OLD.season_id OR
        NEW.event_id IS DISTINCT FROM OLD.event_id OR
        NEW.tournament_id IS DISTINCT FROM OLD.tournament_id OR
        NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
      THEN
        RAISE EXCEPTION 'validated live league checkpoint scope is immutable' USING ERRCODE = '55000';
      END IF;
      IF NEW.publication_id IS NOT DISTINCT FROM OLD.publication_id AND (
        NEW.generation IS DISTINCT FROM OLD.generation OR
        NEW.state IS DISTINCT FROM OLD.state OR
        (
          NEW.manifest
            #- ARRAY['times', 'checkpointedAt']
            #- ARRAY['times', 'sourceCheckedAt']
            #- ARRAY['times', 'expectedNextCheckAt']
        ) IS DISTINCT FROM (
          OLD.manifest
            #- ARRAY['times', 'checkpointedAt']
            #- ARRAY['times', 'sourceCheckedAt']
            #- ARRAY['times', 'expectedNextCheckAt']
        ) OR
        (
          OLD.state = 'FINALIZED' AND
          (NEW.manifest #- ARRAY['times', 'checkpointedAt']) IS DISTINCT FROM
            (OLD.manifest #- ARRAY['times', 'checkpointedAt'])
        ) OR
        NEW.index_payload IS DISTINCT FROM OLD.index_payload OR
        NEW.payload IS DISTINCT FROM OLD.payload OR
        NEW.row_count IS DISTINCT FROM OLD.row_count OR
        NEW.payload_bytes IS DISTINCT FROM OLD.payload_bytes OR
        NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
      ) THEN
        RAISE EXCEPTION 'validated live league checkpoint is immutable' USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' AND OLD.validation_version >= 1 THEN
    IF TG_TABLE_NAME = 'dataset_publications' THEN
      IF OLD.status = 'active' THEN
        RAISE EXCEPTION 'validated active publication cannot be deleted' USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'dataset_publication_items' THEN
      IF EXISTS (
        SELECT 1
        FROM ops.dataset_publications AS publication
        WHERE publication.publication_id = OLD.publication_id
          AND publication.status = 'active'
          AND publication.validation_version >= 1
      ) THEN
        RAISE EXCEPTION 'validated active publication item cannot be deleted' USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'live_points_publication_checkpoints' THEN
      RAISE EXCEPTION 'validated live points checkpoint cannot be deleted' USING ERRCODE = '55000';
    ELSIF TG_TABLE_NAME = 'live_league_checkpoints' THEN
      RAISE EXCEPTION 'validated live league checkpoint cannot be deleted' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dataset_publication_items_validation_immutable
  BEFORE UPDATE OR DELETE ON ops.dataset_publication_items
  FOR EACH ROW EXECUTE FUNCTION ops.prevent_validated_publication_mutation();

CREATE TRIGGER dataset_publications_validation_immutable
  BEFORE UPDATE OR DELETE ON ops.dataset_publications
  FOR EACH ROW EXECUTE FUNCTION ops.prevent_validated_publication_mutation();

CREATE TRIGGER live_league_checkpoints_validation_immutable
  BEFORE UPDATE OR DELETE ON competition.live_league_checkpoints
  FOR EACH ROW EXECUTE FUNCTION ops.prevent_validated_publication_mutation();

CREATE TRIGGER live_points_publication_checkpoints_validation_immutable
  BEFORE UPDATE OR DELETE ON competition.live_points_publication_checkpoints
  FOR EACH ROW EXECUTE FUNCTION ops.prevent_validated_publication_mutation();

REVOKE ALL ON FUNCTION ops.prevent_validated_publication_mutation() FROM PUBLIC;

COMMIT;
