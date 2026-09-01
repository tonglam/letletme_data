-- My Tournament Review V2.1 hard cut.
--
-- This migration is intentionally destructive for the current season, but it
-- is recoverable: the three review tables are copied to immutable backup
-- tables and a manifest records row counts, revision distribution and a
-- checksum before the old head/obligation rows are retired.  The deployment
-- runbook restores these backup tables into a disposable database before the
-- migration is allowed to proceed in production.

CREATE SCHEMA IF NOT EXISTS extensions;

-- `eligible_at` remains the source-change watermark.  Keep the first time a
-- scope became eligible separately so repeated source retries cannot move the
-- 24-hour degradation horizon forward forever.
ALTER TABLE competition.tournament_review_obligations
  ADD COLUMN IF NOT EXISTS first_eligible_at timestamptz;
UPDATE competition.tournament_review_obligations
SET first_eligible_at = eligible_at
WHERE first_eligible_at IS NULL;
ALTER TABLE competition.tournament_review_obligations
  ALTER COLUMN first_eligible_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN first_eligible_at SET NOT NULL;

DO $$
DECLARE
  installed_schema text;
BEGIN
  SELECT namespace.nspname
    INTO installed_schema
  FROM pg_extension extension_row
  JOIN pg_namespace namespace ON namespace.oid = extension_row.extnamespace
  WHERE extension_row.extname = 'pgcrypto';

  IF installed_schema IS NULL THEN
    EXECUTE 'CREATE EXTENSION pgcrypto WITH SCHEMA extensions';
  ELSIF installed_schema <> 'extensions' THEN
    EXECUTE 'ALTER EXTENSION pgcrypto SET SCHEMA extensions';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS competition.tournament_review_publications_0084_backup
  (LIKE competition.tournament_review_publications INCLUDING ALL);
CREATE TABLE IF NOT EXISTS competition.tournament_review_heads_0084_backup
  (LIKE competition.tournament_review_heads INCLUDING ALL);
CREATE TABLE IF NOT EXISTS competition.tournament_review_obligations_0084_backup
  (LIKE competition.tournament_review_obligations INCLUDING ALL);

CREATE TABLE IF NOT EXISTS ops.tournament_review_v2_1_backup_manifest (
  backup_id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  season_id smallint NOT NULL,
  publications_rows bigint NOT NULL,
  heads_rows bigint NOT NULL,
  obligations_rows bigint NOT NULL,
  publication_revision_distribution jsonb NOT NULL,
  publications_sha256 text NOT NULL,
  heads_sha256 text NOT NULL,
  obligations_sha256 text NOT NULL,
  restore_rehearsal_required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tournament_review_v2_1_backup_manifest_sha_check CHECK (
    publications_sha256 ~ '^[0-9a-f]{64}$'
    AND heads_sha256 ~ '^[0-9a-f]{64}$'
    AND obligations_sha256 ~ '^[0-9a-f]{64}$'
  )
);
REVOKE ALL ON TABLE ops.tournament_review_v2_1_backup_manifest FROM PUBLIC;
GRANT SELECT ON TABLE ops.tournament_review_v2_1_backup_manifest TO letletme_data_writer;

DO $migration$
DECLARE
  current_season smallint;
  publication_count bigint;
  head_count bigint;
  obligation_count bigint;
  publication_sha text;
  head_sha text;
  obligation_sha text;
  revision_distribution jsonb;
BEGIN
  SELECT season_id INTO current_season
  FROM fpl.seasons
  WHERE is_current
  ORDER BY season_id DESC
  LIMIT 1;

  IF current_season IS NULL THEN
    -- Schema-only CI/restore databases may be empty before the first FPL
    -- season is seeded.  Apply the structural hard-cut below, but there is no
    -- current-season data to back up or reset in that case.
    RAISE NOTICE '0084 skipped current-season backup/reset because no current FPL season exists';
    RETURN;
  END IF;

  -- Copy only the current season.  Historical descriptive-v1 evidence remains
  -- in the live tables and is never exposed by the V2.1 reader.
  INSERT INTO competition.tournament_review_publications_0084_backup
  SELECT * FROM competition.tournament_review_publications
  WHERE season_id = current_season;
  INSERT INTO competition.tournament_review_heads_0084_backup
  SELECT * FROM competition.tournament_review_heads
  WHERE season_id = current_season;
  INSERT INTO competition.tournament_review_obligations_0084_backup
  SELECT * FROM competition.tournament_review_obligations
  WHERE season_id = current_season;

  SELECT count(*) INTO publication_count
  FROM competition.tournament_review_publications_0084_backup;
  SELECT count(*) INTO head_count
  FROM competition.tournament_review_heads_0084_backup;
  SELECT count(*) INTO obligation_count
  FROM competition.tournament_review_obligations_0084_backup;

  SELECT COALESCE(jsonb_object_agg(revision::text, revision_count), '{}'::jsonb)
    INTO revision_distribution
  FROM (
    SELECT revision, count(*)::bigint AS revision_count
    FROM competition.tournament_review_publications_0084_backup
    GROUP BY revision
    ORDER BY revision
  ) revisions;

  -- Canonical JSON over deterministic row ordering is the backup checksum.
  SELECT encode(extensions.digest(COALESCE(jsonb_agg(to_jsonb(row) ORDER BY season_id,
      tournament_id, event_id, revision)::text, '[]'), 'sha256'), 'hex')
    INTO publication_sha
  FROM competition.tournament_review_publications_0084_backup row;
  SELECT encode(extensions.digest(COALESCE(jsonb_agg(to_jsonb(row) ORDER BY season_id,
      tournament_id, event_id)::text, '[]'), 'sha256'), 'hex')
    INTO head_sha
  FROM competition.tournament_review_heads_0084_backup row;
  SELECT encode(extensions.digest(COALESCE(jsonb_agg(to_jsonb(row) ORDER BY season_id,
      tournament_id, event_id)::text, '[]'), 'sha256'), 'hex')
    INTO obligation_sha
  FROM competition.tournament_review_obligations_0084_backup row;

  INSERT INTO ops.tournament_review_v2_1_backup_manifest (
    season_id, publications_rows, heads_rows, obligations_rows,
    publication_revision_distribution, publications_sha256, heads_sha256,
    obligations_sha256
  ) VALUES (
    current_season, publication_count, head_count, obligation_count,
    revision_distribution, publication_sha, head_sha, obligation_sha
  );

  -- Current-season V1/V2 publication identity is intentionally invalidated;
  -- obligations are re-seeded by the bounded V2.1 bootstrap job.
  DELETE FROM competition.tournament_review_heads WHERE season_id = current_season;
  DELETE FROM competition.tournament_review_publications WHERE season_id = current_season;
  DELETE FROM competition.tournament_review_obligations WHERE season_id = current_season;
END
$migration$;

-- The hard cut has no compatibility alias for the retired review contract.
-- Move durable governance evidence to the V2.1 key while preserving any
-- already-open V2.1 case when a legacy duplicate occupies the same dedupe
-- identity.  This keeps freshness windows and repair lanes observable after
-- the registry switches to the single V2.1 contract.
UPDATE ops.freshness_slo_windows
SET contract_key = 'my-tournament-review-v2.1',
    updated_at = clock_timestamp()
WHERE contract_key = 'my-tournament-review-v2';

WITH conflicting_cases AS (
  SELECT legacy.case_id
  FROM ops.data_governance_cases legacy
  JOIN ops.data_governance_cases current_case
    ON current_case.case_kind = legacy.case_kind
   AND current_case.contract_key = 'my-tournament-review-v2.1'
   AND current_case.lane = legacy.lane
   AND current_case.scope_key = legacy.scope_key
   AND current_case.fingerprint = legacy.fingerprint
   AND current_case.status IN ('OPEN', 'AUTO_REPAIRING', 'REQUIRES_REVIEW')
  WHERE legacy.contract_key = 'my-tournament-review-v2'
    AND legacy.status IN ('OPEN', 'AUTO_REPAIRING', 'REQUIRES_REVIEW')
)
UPDATE ops.data_governance_cases legacy
SET status = 'DISMISSED',
    last_error = 'Retired review contract superseded by my-tournament-review-v2.1',
    recovered_at = COALESCE(recovered_at, clock_timestamp()),
    updated_at = clock_timestamp()
WHERE legacy.case_id IN (SELECT case_id FROM conflicting_cases);

UPDATE ops.data_governance_cases
SET contract_key = 'my-tournament-review-v2.1',
    updated_at = clock_timestamp()
WHERE contract_key = 'my-tournament-review-v2';

ALTER TABLE competition.tournament_review_publications
  DROP CONSTRAINT IF EXISTS tournament_review_publications_versions_check;
-- A semantic hash may legitimately recur after an audited correction (A -> B
-- -> A).  Revision, not hash, is the immutable audit identity; remove the V1
-- uniqueness fence before the V2.1 writer can allocate that next revision.
DROP INDEX IF EXISTS competition.tournament_review_publications_content_unique;
ALTER TABLE competition.tournament_review_publications
  ALTER COLUMN schema_version SET DEFAULT 'my-tournament-review-v2.1',
  ALTER COLUMN metric_version SET DEFAULT 'settled-review-v2';
ALTER TABLE competition.tournament_review_publications
  ADD CONSTRAINT tournament_review_publications_versions_check CHECK (
    (schema_version = 'my-tournament-review-v2' AND metric_version = 'descriptive-v1')
    OR (schema_version = 'my-tournament-review-v2.1' AND metric_version = 'settled-review-v2')
  );

ALTER TABLE competition.tournament_review_publications
  ADD COLUMN IF NOT EXISTS correction_reason text,
  ADD COLUMN IF NOT EXISTS correction_change_id text;
ALTER TABLE competition.tournament_review_publications
  ADD CONSTRAINT tournament_review_publications_correction_check CHECK (
    schema_version <> 'my-tournament-review-v2.1'
    OR (
      (revision = 1 AND correction_reason IS NULL AND correction_change_id IS NULL)
      OR (revision > 1 AND correction_reason IS NOT NULL AND correction_change_id IS NOT NULL)
    )
  );

ALTER TABLE competition.tournament_review_obligations
  ADD COLUMN IF NOT EXISTS last_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_noop_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_semantic_change_at timestamptz,
  ADD COLUMN IF NOT EXISTS repair_issue_id bigint,
  ADD COLUMN IF NOT EXISTS correction_reason text,
  ADD COLUMN IF NOT EXISTS correction_change_id text;
ALTER TABLE competition.tournament_review_obligations
  ADD CONSTRAINT tournament_review_obligations_correction_check CHECK (
    (correction_reason IS NULL AND correction_change_id IS NULL)
    OR (
      btrim(correction_reason) <> ''
      AND btrim(correction_change_id) <> ''
    )
  );

CREATE TABLE IF NOT EXISTS competition.tournament_review_publication_chunks (
  season_id smallint NOT NULL,
  tournament_id integer NOT NULL,
  event_id integer NOT NULL,
  revision bigint NOT NULL,
  section_key text NOT NULL,
  chunk_index integer NOT NULL,
  item_count integer NOT NULL,
  chunk_sha256 text NOT NULL,
  items jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tournament_review_publication_chunks_pkey PRIMARY KEY
    (season_id, tournament_id, event_id, revision, section_key, chunk_index),
  CONSTRAINT tournament_review_publication_chunks_publication_fk FOREIGN KEY
    (season_id, tournament_id, event_id, revision)
    REFERENCES competition.tournament_review_publications
      (season_id, tournament_id, event_id, revision) ON DELETE CASCADE,
  CONSTRAINT tournament_review_publication_chunks_count_check CHECK (
    chunk_index >= 0 AND item_count BETWEEN 0 AND 100 AND jsonb_typeof(items) = 'array'
    AND jsonb_array_length(items) = item_count
  ),
  CONSTRAINT tournament_review_publication_chunks_sha_check CHECK (
    chunk_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX IF NOT EXISTS tournament_review_publication_chunks_lookup_idx
  ON competition.tournament_review_publication_chunks
    (season_id, tournament_id, event_id, revision, section_key, chunk_index);

REVOKE ALL ON TABLE competition.tournament_review_publication_chunks FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON TABLE competition.tournament_review_publication_chunks
  TO letletme_data_writer;
GRANT UPDATE ON TABLE competition.tournament_review_publication_chunks
  TO letletme_data_writer;
GRANT SELECT ON TABLE competition.tournament_review_publication_chunks
  TO letletme_graphql_reader;
ALTER TABLE competition.tournament_review_publication_chunks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tournament_review_chunks_writer_insert ON
  competition.tournament_review_publication_chunks;
DROP POLICY IF EXISTS tournament_review_chunks_writer_select ON
  competition.tournament_review_publication_chunks;
DROP POLICY IF EXISTS tournament_review_chunks_writer_delete ON
  competition.tournament_review_publication_chunks;
DROP POLICY IF EXISTS tournament_review_chunks_writer_update ON
  competition.tournament_review_publication_chunks;
DROP POLICY IF EXISTS tournament_review_chunks_reader_select ON
  competition.tournament_review_publication_chunks;
CREATE POLICY tournament_review_chunks_writer_insert ON
  competition.tournament_review_publication_chunks FOR INSERT TO letletme_data_writer
  WITH CHECK (true);
CREATE POLICY tournament_review_chunks_writer_select ON
  competition.tournament_review_publication_chunks FOR SELECT TO letletme_data_writer
  USING (true);
CREATE POLICY tournament_review_chunks_writer_delete ON
  competition.tournament_review_publication_chunks FOR DELETE TO letletme_data_writer
  USING (true);
CREATE POLICY tournament_review_chunks_writer_update ON
  competition.tournament_review_publication_chunks FOR UPDATE TO letletme_data_writer
  USING (true) WITH CHECK (true);
CREATE POLICY tournament_review_chunks_reader_select ON
  competition.tournament_review_publication_chunks FOR SELECT TO letletme_graphql_reader
  USING (true);

COMMENT ON COLUMN competition.tournament_review_publications.content_sha256 IS
  'Physical column retained for history; V2.1 consumers expose it as semanticSha256.';
COMMENT ON TABLE competition.tournament_review_publication_chunks IS
  'Immutable <=100-item sections for settled-review-v2 publications.';
