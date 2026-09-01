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
  backfill_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tournament_review_v2_1_backup_manifest_sha_check CHECK (
    publications_sha256 ~ '^[0-9a-f]{64}$'
    AND heads_sha256 ~ '^[0-9a-f]{64}$'
    AND obligations_sha256 ~ '^[0-9a-f]{64}$'
  )
);
REVOKE ALL ON TABLE ops.tournament_review_v2_1_backup_manifest FROM PUBLIC;
GRANT SELECT, UPDATE ON TABLE ops.tournament_review_v2_1_backup_manifest TO letletme_data_writer;

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
DO $migration$
DECLARE
  duplicate_row record;
BEGIN
  -- `slo_key` is the identity column.  Merge an old row into an already
  -- migrated V2.1 row before changing the key, otherwise the unique identity
  -- constraint would abort the cutover halfway through the governance table.
  FOR duplicate_row IN
    SELECT legacy.window_id AS legacy_window_id,
           canonical.window_id AS canonical_window_id,
           legacy.evidence AS legacy_evidence
    FROM ops.freshness_slo_windows legacy
    JOIN ops.freshness_slo_windows canonical
      ON canonical.slo_key = 'my-tournament-review-v2.1'
     AND canonical.scope_key = legacy.scope_key
     AND canonical.period_key = legacy.period_key
     AND canonical.window_id <> legacy.window_id
    WHERE legacy.slo_key = 'my-tournament-review-v2'
       OR legacy.contract_key = 'my-tournament-review-v2'
  LOOP
    UPDATE ops.freshness_slo_windows AS canonical
    SET -- The duplicate rows are one logical SLO window.  Keep the earliest
        -- eligibility boundary, then merge every monotonic observation and
        -- terminal result before deleting the legacy identity.  In
        -- particular, a canonical PENDING row must not erase a legacy MET or
        -- BREACHED result that already has completion/recovery evidence.
        eligible_at = LEAST(canonical.eligible_at, legacy.eligible_at),
        due_at = LEAST(canonical.due_at, legacy.due_at),
        event_id = COALESCE(canonical.event_id, legacy.event_id),
        source_day = COALESCE(canonical.source_day, legacy.source_day),
        obligation_due_at = CASE
          WHEN canonical.obligation_due_at IS NULL THEN legacy.obligation_due_at
          WHEN legacy.obligation_due_at IS NULL THEN canonical.obligation_due_at
          ELSE GREATEST(canonical.obligation_due_at, legacy.obligation_due_at)
        END,
        source_checked_at = CASE
          WHEN canonical.source_checked_at IS NULL THEN legacy.source_checked_at
          WHEN legacy.source_checked_at IS NULL THEN canonical.source_checked_at
          ELSE GREATEST(canonical.source_checked_at, legacy.source_checked_at)
        END,
        pg_published_at = CASE
          WHEN canonical.pg_published_at IS NULL THEN legacy.pg_published_at
          WHEN legacy.pg_published_at IS NULL THEN canonical.pg_published_at
          ELSE GREATEST(canonical.pg_published_at, legacy.pg_published_at)
        END,
        redis_seen_at = CASE
          WHEN canonical.redis_seen_at IS NULL THEN legacy.redis_seen_at
          WHEN legacy.redis_seen_at IS NULL THEN canonical.redis_seen_at
          ELSE GREATEST(canonical.redis_seen_at, legacy.redis_seen_at)
        END,
        graphql_seen_at = CASE
          WHEN canonical.graphql_seen_at IS NULL THEN legacy.graphql_seen_at
          WHEN legacy.graphql_seen_at IS NULL THEN canonical.graphql_seen_at
          ELSE GREATEST(canonical.graphql_seen_at, legacy.graphql_seen_at)
        END,
        web_seen_at = CASE
          WHEN canonical.web_seen_at IS NULL THEN legacy.web_seen_at
          WHEN legacy.web_seen_at IS NULL THEN canonical.web_seen_at
          ELSE GREATEST(canonical.web_seen_at, legacy.web_seen_at)
        END,
        -- Revisions follow the milestone that observed them.  Falling back to
        -- the other row keeps a complete terminal record when the duplicate
        -- was only partially observed.
        producer_revision = CASE
          WHEN canonical.pg_published_at IS NULL THEN legacy.producer_revision
          WHEN legacy.pg_published_at IS NULL THEN canonical.producer_revision
          WHEN legacy.pg_published_at > canonical.pg_published_at THEN
            COALESCE(legacy.producer_revision, canonical.producer_revision)
          ELSE COALESCE(canonical.producer_revision, legacy.producer_revision)
        END,
        redis_revision = CASE
          WHEN canonical.redis_seen_at IS NULL THEN legacy.redis_revision
          WHEN legacy.redis_seen_at IS NULL THEN canonical.redis_revision
          WHEN legacy.redis_seen_at > canonical.redis_seen_at THEN
            COALESCE(legacy.redis_revision, canonical.redis_revision)
          ELSE COALESCE(canonical.redis_revision, legacy.redis_revision)
        END,
        graphql_revision = CASE
          WHEN canonical.graphql_seen_at IS NULL THEN legacy.graphql_revision
          WHEN legacy.graphql_seen_at IS NULL THEN canonical.graphql_revision
          WHEN legacy.graphql_seen_at > canonical.graphql_seen_at THEN
            COALESCE(legacy.graphql_revision, canonical.graphql_revision)
          ELSE COALESCE(canonical.graphql_revision, legacy.graphql_revision)
        END,
        web_revision = CASE
          WHEN canonical.web_seen_at IS NULL THEN legacy.web_revision
          WHEN legacy.web_seen_at IS NULL THEN canonical.web_revision
          WHEN legacy.web_seen_at > canonical.web_seen_at THEN
            COALESCE(legacy.web_revision, canonical.web_revision)
          ELSE COALESCE(canonical.web_revision, legacy.web_revision)
        END,
        expected_count = CASE
          WHEN canonical.expected_count IS NULL THEN legacy.expected_count
          WHEN legacy.expected_count IS NULL THEN canonical.expected_count
          ELSE GREATEST(canonical.expected_count, legacy.expected_count)
        END,
        observed_count = CASE
          WHEN canonical.observed_count IS NULL THEN legacy.observed_count
          WHEN legacy.observed_count IS NULL THEN canonical.observed_count
          ELSE GREATEST(canonical.observed_count, legacy.observed_count)
        END,
        not_applicable_count = GREATEST(
          canonical.not_applicable_count,
          legacy.not_applicable_count
        ),
        completeness_status = CASE
          WHEN CASE legacy.completeness_status
            WHEN 'INVALID' THEN 4
            WHEN 'INCOMPLETE' THEN 3
            WHEN 'COMPLETE' THEN 2
            WHEN 'NOT_APPLICABLE' THEN 1
            ELSE 0
          END > CASE canonical.completeness_status
            WHEN 'INVALID' THEN 4
            WHEN 'INCOMPLETE' THEN 3
            WHEN 'COMPLETE' THEN 2
            WHEN 'NOT_APPLICABLE' THEN 1
            ELSE 0
          END THEN legacy.completeness_status
          ELSE canonical.completeness_status
        END,
        status = CASE
          WHEN CASE legacy.status
            WHEN 'INVALID' THEN 4
            WHEN 'BREACHED' THEN 3
            WHEN 'MET' THEN 2
            WHEN 'NOT_APPLICABLE' THEN 1
            ELSE 0
          END > CASE canonical.status
            WHEN 'INVALID' THEN 4
            WHEN 'BREACHED' THEN 3
            WHEN 'MET' THEN 2
            WHEN 'NOT_APPLICABLE' THEN 1
            ELSE 0
          END THEN legacy.status
          ELSE canonical.status
        END,
        -- Prefer the breach code attached to the row whose terminal status
        -- wins; retain the other code when the winning row is incomplete.
        breach_code = CASE
          WHEN CASE legacy.status
            WHEN 'INVALID' THEN 4
            WHEN 'BREACHED' THEN 3
            WHEN 'MET' THEN 2
            WHEN 'NOT_APPLICABLE' THEN 1
            ELSE 0
          END > CASE canonical.status
            WHEN 'INVALID' THEN 4
            WHEN 'BREACHED' THEN 3
            WHEN 'MET' THEN 2
            WHEN 'NOT_APPLICABLE' THEN 1
            ELSE 0
          END THEN COALESCE(legacy.breach_code, canonical.breach_code)
          ELSE COALESCE(canonical.breach_code, legacy.breach_code)
        END,
        recovered_at = CASE
          WHEN canonical.recovered_at IS NULL THEN legacy.recovered_at
          WHEN legacy.recovered_at IS NULL THEN canonical.recovered_at
          ELSE LEAST(canonical.recovered_at, legacy.recovered_at)
        END,
        recovery_revision = CASE
          WHEN canonical.recovered_at IS NULL THEN legacy.recovery_revision
          WHEN legacy.recovered_at IS NULL THEN canonical.recovery_revision
          WHEN legacy.recovered_at < canonical.recovered_at THEN
            COALESCE(legacy.recovery_revision, canonical.recovery_revision)
          ELSE COALESCE(canonical.recovery_revision, legacy.recovery_revision)
        END,
        created_at = LEAST(canonical.created_at, legacy.created_at),
        -- Merge both evidence objects at the top level, then retain a
        -- namespaced copy of the retired row for audit/recovery inspection.
        evidence = legacy.evidence || canonical.evidence || jsonb_build_object(
          'supersededLegacyWindowId', duplicate_row.legacy_window_id,
          'supersededLegacyEvidence', duplicate_row.legacy_evidence,
          'supersededLegacyRow', to_jsonb(legacy)
        ),
        updated_at = clock_timestamp()
    FROM ops.freshness_slo_windows AS legacy
    WHERE canonical.window_id = duplicate_row.canonical_window_id
      AND legacy.window_id = duplicate_row.legacy_window_id;
    DELETE FROM ops.freshness_slo_windows
    WHERE window_id = duplicate_row.legacy_window_id;
  END LOOP;
END
$migration$;

UPDATE ops.freshness_slo_windows
SET slo_key = 'my-tournament-review-v2.1',
    contract_key = 'my-tournament-review-v2.1',
    updated_at = clock_timestamp()
WHERE slo_key = 'my-tournament-review-v2'
   OR contract_key = 'my-tournament-review-v2';

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
      OR (
        revision > 1
        AND correction_reason IS NOT NULL
        AND correction_change_id IS NOT NULL
        AND btrim(correction_reason) <> ''
        AND btrim(correction_change_id) <> ''
      )
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
      correction_reason IS NOT NULL
      AND correction_change_id IS NOT NULL
      AND btrim(correction_reason) <> ''
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
    item_count BETWEEN 0 AND 100 AND jsonb_typeof(items) = 'array'
    AND jsonb_array_length(items) = item_count
  ),
  CONSTRAINT tournament_review_publication_chunks_index_check CHECK (chunk_index >= 0),
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
