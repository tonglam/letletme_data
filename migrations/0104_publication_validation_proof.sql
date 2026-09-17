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

-- Application locks and semantic checks are the normal write boundary. Keep a
-- database fence as well so a direct writer cannot replace a payload after it
-- has been marked as validated. Retiring/deleting old rows remains allowed;
-- only an in-place content mutation is rejected.
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
    IF TG_TABLE_NAME = 'dataset_publication_items' AND (
      NEW.publication_id IS DISTINCT FROM OLD.publication_id OR
      NEW.item_name IS DISTINCT FROM OLD.item_name OR
      NEW.payload IS DISTINCT FROM OLD.payload OR
      NEW.item_count IS DISTINCT FROM OLD.item_count OR
      NEW.checksum IS DISTINCT FROM OLD.checksum
    ) THEN
      RAISE EXCEPTION 'validated publication item is immutable' USING ERRCODE = '55000';
    ELSIF TG_TABLE_NAME = 'dataset_publications' AND (
      NEW.publication_id IS DISTINCT FROM OLD.publication_id OR
      NEW.dataset IS DISTINCT FROM OLD.dataset OR
      NEW.season_id IS DISTINCT FROM OLD.season_id OR
      NEW.event_id IS DISTINCT FROM OLD.event_id OR
      NEW.revision IS DISTINCT FROM OLD.revision OR
      NEW.manifest IS DISTINCT FROM OLD.manifest
    ) THEN
      RAISE EXCEPTION 'validated publication identity is immutable' USING ERRCODE = '55000';
    ELSIF TG_TABLE_NAME = 'live_league_checkpoints' AND
      NEW.publication_id IS NOT DISTINCT FROM OLD.publication_id AND (
        NEW.generation IS DISTINCT FROM OLD.generation OR
        NEW.state IS DISTINCT FROM OLD.state OR
        -- A marker retry may refresh only checkpointedAt after the durable
        -- row committed. All other manifest identity/timing fields remain
        -- immutable, so a same-identity retry cannot replace its proof.
        (NEW.manifest #- ARRAY['times', 'checkpointedAt']) IS DISTINCT FROM
          (OLD.manifest #- ARRAY['times', 'checkpointedAt']) OR
        NEW.index_payload IS DISTINCT FROM OLD.index_payload OR
        NEW.payload IS DISTINCT FROM OLD.payload OR
        NEW.row_count IS DISTINCT FROM OLD.row_count OR
        NEW.payload_bytes IS DISTINCT FROM OLD.payload_bytes OR
        NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
      ) THEN
      RAISE EXCEPTION 'validated live league checkpoint is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dataset_publication_items_validation_immutable
  BEFORE UPDATE ON ops.dataset_publication_items
  FOR EACH ROW EXECUTE FUNCTION ops.prevent_validated_publication_mutation();

CREATE TRIGGER dataset_publications_validation_immutable
  BEFORE UPDATE ON ops.dataset_publications
  FOR EACH ROW EXECUTE FUNCTION ops.prevent_validated_publication_mutation();

CREATE TRIGGER live_league_checkpoints_validation_immutable
  BEFORE UPDATE ON competition.live_league_checkpoints
  FOR EACH ROW EXECUTE FUNCTION ops.prevent_validated_publication_mutation();

REVOKE ALL ON FUNCTION ops.prevent_validated_publication_mutation() FROM PUBLIC;

COMMIT;
