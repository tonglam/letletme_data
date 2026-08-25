-- Immutable raw FPL bootstrap evidence. Current-day collectors archive the
-- exact provider bytes before any market mutation; historical replay is
-- allowed only from one of these source-day artifacts.

CREATE TABLE ops.fpl_source_artifacts (
  artifact_id uuid PRIMARY KEY,
  provider text NOT NULL DEFAULT 'fpl',
  dataset text NOT NULL DEFAULT 'bootstrap-static',
  season_id smallint NOT NULL
    REFERENCES fpl.seasons(season_id) ON DELETE RESTRICT,
  source_day date NOT NULL,
  source_timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  source_url text NOT NULL,
  bucket text NOT NULL,
  object_key text NOT NULL,
  sha256 text NOT NULL,
  byte_size bigint NOT NULL,
  content_type text NOT NULL,
  retrieved_at timestamptz NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  item_counts jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fpl_source_artifacts_capture_key
    UNIQUE (provider, dataset, season_id, source_day, sha256),
  CONSTRAINT fpl_source_artifacts_season_artifact_key UNIQUE (season_id, artifact_id),
  CONSTRAINT fpl_source_artifacts_object_key UNIQUE (bucket, object_key),
  CONSTRAINT fpl_source_artifacts_provider_check CHECK (provider = 'fpl'),
  CONSTRAINT fpl_source_artifacts_dataset_check CHECK (dataset = 'bootstrap-static'),
  CONSTRAINT fpl_source_artifacts_timezone_check CHECK (source_timezone = 'Asia/Shanghai'),
  CONSTRAINT fpl_source_artifacts_url_check CHECK (
    source_url ~ '^https://fantasy\.premierleague\.com/api/bootstrap-static/([?].*)?$'
  ),
  CONSTRAINT fpl_source_artifacts_bucket_check CHECK (bucket = 'fpl-raw-snapshots'),
  CONSTRAINT fpl_source_artifacts_object_key_check CHECK (
    object_key ~ '^fpl/bootstrap-static/[0-9]{4}/[0-9]{8}/[0-9a-f]{64}\.json$'
  ),
  CONSTRAINT fpl_source_artifacts_sha_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT fpl_source_artifacts_size_check CHECK (byte_size > 0 AND byte_size <= 8388608),
  CONSTRAINT fpl_source_artifacts_content_type_check CHECK (content_type = 'application/json'),
  CONSTRAINT fpl_source_artifacts_schema_version_check CHECK (schema_version = 1),
  CONSTRAINT fpl_source_artifacts_counts_check CHECK (
    jsonb_typeof(item_counts) = 'object'
    AND (item_counts->>'events') ~ '^[0-9]+$'
    AND (item_counts->>'teams') ~ '^[0-9]+$'
    AND (item_counts->>'elements') ~ '^[0-9]+$'
    AND (item_counts->>'phases') ~ '^[0-9]+$'
  ),
  CONSTRAINT fpl_source_artifacts_source_day_check CHECK (
    (retrieved_at AT TIME ZONE source_timezone)::date = source_day
  )
);

CREATE INDEX fpl_source_artifacts_day_idx
  ON ops.fpl_source_artifacts (
    season_id,
    source_day,
    retrieved_at DESC NULLS LAST,
    artifact_id DESC NULLS LAST
  );

-- Existing market rows predate raw artifact capture and therefore remain
-- nullable. Every new archive-backed market write records the exact immutable
-- object used, so multiple captures on one source day never make lineage
-- ambiguous.
ALTER TABLE fpl.player_market_snapshots
  ADD COLUMN source_artifact_id uuid;

ALTER TABLE fpl.player_market_snapshots
  ADD CONSTRAINT player_market_snapshots_source_artifact_fk
  FOREIGN KEY (season_id, source_artifact_id)
  REFERENCES ops.fpl_source_artifacts (season_id, artifact_id)
  ON DELETE RESTRICT;

CREATE INDEX player_market_snapshots_source_artifact_idx
  ON fpl.player_market_snapshots (season_id, source_artifact_id)
  WHERE source_artifact_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ops.prevent_fpl_source_artifact_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'fpl_source_artifacts are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER fpl_source_artifacts_immutable
BEFORE UPDATE OR DELETE ON ops.fpl_source_artifacts
FOR EACH ROW EXECUTE FUNCTION ops.prevent_fpl_source_artifact_mutation();

REVOKE ALL ON FUNCTION ops.prevent_fpl_source_artifact_mutation() FROM PUBLIC;
REVOKE ALL ON TABLE ops.fpl_source_artifacts FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE ops.fpl_source_artifacts TO letletme_data_writer;
REVOKE ALL ON TABLE ops.fpl_source_artifacts FROM letletme_graphql_reader;

COMMENT ON TABLE ops.fpl_source_artifacts IS
  'Immutable exact-byte bootstrap-static captures, partitioned logically by UTC+8 source day';
