-- Normalize pre-runtime publication IDs to the RFC UUID shape required by the
-- immutable Redis publication contract, then make that boundary enforceable.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL ROLE letletme_data_owner;

LOCK TABLE ops.dataset_publications, ops.sync_runs IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE publication_id_remap ON COMMIT DROP AS
SELECT
  publication.publication_id AS old_publication_id,
  overlay(
    overlay(publication.publication_id::text placing '4' from 15 for 1)
    placing '8' from 20 for 1
  )::uuid AS new_publication_id
FROM ops.dataset_publications publication
WHERE publication.publication_id::text !~
  '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

DO $publication_id_remap_contract$
BEGIN
  IF EXISTS (
    SELECT remap.new_publication_id
    FROM publication_id_remap remap
    GROUP BY remap.new_publication_id
    HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1
    FROM publication_id_remap remap
    JOIN ops.dataset_publications publication
      ON publication.publication_id = remap.new_publication_id
     AND publication.publication_id <> remap.old_publication_id
  ) THEN
    RAISE EXCEPTION 'publication UUID normalization would create an identity collision';
  END IF;
END
$publication_id_remap_contract$;

CREATE TEMP TABLE sync_run_publication_remap ON COMMIT DROP AS
SELECT run.run_id, remap.new_publication_id
FROM ops.sync_runs run
JOIN publication_id_remap remap ON remap.old_publication_id = run.publication_id;

UPDATE ops.sync_runs run
SET publication_id = NULL
FROM sync_run_publication_remap remap
WHERE remap.run_id = run.run_id;

UPDATE ops.dataset_publications publication
SET publication_id = remap.new_publication_id
FROM publication_id_remap remap
WHERE publication.publication_id = remap.old_publication_id;

UPDATE ops.sync_runs run
SET publication_id = remap.new_publication_id
FROM sync_run_publication_remap remap
WHERE remap.run_id = run.run_id;

ALTER TABLE ops.dataset_publications
  ADD CONSTRAINT dataset_publications_publication_id_rfc_uuid
  CHECK (
    publication_id::text ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) NOT VALID;

ALTER TABLE ops.dataset_publications
  VALIDATE CONSTRAINT dataset_publications_publication_id_rfc_uuid;

UPDATE ops.dataset_publications
SET
  manifest = jsonb_set(manifest, '{planVersion}', '"3.2.5"'::jsonb, true),
  updated_at = now()
WHERE manifest ->> 'schemaVersion' = 'v3'
  AND manifest ->> 'planVersion' IS DISTINCT FROM '3.2.5';

DO $publication_identity_contract$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ops.dataset_publications publication
    WHERE publication.publication_id::text !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'ops.dataset_publications contains a non-RFC publication UUID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ops.dataset_publications publication
    WHERE publication.manifest ->> 'schemaVersion' = 'v3'
      AND publication.manifest ->> 'planVersion' IS DISTINCT FROM '3.2.5'
  ) THEN
    RAISE EXCEPTION 'v3 publication plan version normalization failed';
  END IF;
END
$publication_identity_contract$;

RESET ROLE;
