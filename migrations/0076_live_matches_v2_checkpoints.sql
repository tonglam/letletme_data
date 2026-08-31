-- Live Matches V2 compact checkpoints.
--
-- Redis is the serving authority. These tables are the complete same-event
-- cold fallback and async repair target; they are never written from the
-- provider/Redis hot path transaction. Redis TIME and PostgreSQL timestamps
-- come from different clocks, so this migration intentionally has no clock
-- ordering CHECK constraint.

CREATE TABLE fpl.live_match_desk_checkpoints (
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  publication_id text NOT NULL,
  generation bigint NOT NULL,
  state text NOT NULL,
  manifest jsonb NOT NULL,
  revisions jsonb NOT NULL,
  payload jsonb NOT NULL,
  row_count integer NOT NULL,
  payload_bytes integer NOT NULL,
  payload_sha256 text NOT NULL,
  source_checked_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL,
  checkpointed_at timestamptz NOT NULL,
  expected_next_check_at timestamptz,
  stale_at timestamptz,
  CONSTRAINT live_match_desk_checkpoints_pkey PRIMARY KEY (season_id, event_id),
  CONSTRAINT live_match_desk_checkpoints_event_fk
    FOREIGN KEY (season_id, event_id)
    REFERENCES fpl.events (season_id, event_id),
  CONSTRAINT live_match_desk_checkpoints_publication_once
    UNIQUE (season_id, event_id, publication_id),
  CONSTRAINT live_match_desk_checkpoints_identity_valid CHECK (
    event_id > 0
    AND generation > 0
    AND publication_id ~ '^[0-9a-f-]{36}$'
    AND state = ANY (ARRAY[
      'PRE_DEADLINE', 'LIVE_ACTIVE', 'BETWEEN_FIXTURES',
      'DAY_SETTLING', 'GW_REVIEW', 'FINALIZED'
    ]::text[])
  ),
  CONSTRAINT live_match_desk_checkpoints_payload_valid CHECK (
    jsonb_typeof(manifest) = 'object'
    AND pg_column_size(manifest) <= 131072
    AND jsonb_typeof(revisions) = 'object'
    AND jsonb_typeof(payload) = 'array'
    AND row_count = jsonb_array_length(payload)
    AND row_count BETWEEN 0 AND 32
    AND payload_bytes BETWEEN 0 AND 131072
    AND payload_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX live_match_desk_checkpoints_generation_idx
  ON fpl.live_match_desk_checkpoints (season_id, event_id, generation);

CREATE TABLE fpl.live_match_detail_checkpoints (
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  publication_id text NOT NULL,
  generation bigint NOT NULL,
  state text NOT NULL,
  observed_desk_generation bigint NOT NULL,
  fixture_identity_revision text NOT NULL,
  manifest jsonb NOT NULL,
  revisions jsonb NOT NULL,
  payload jsonb NOT NULL,
  row_count integer NOT NULL,
  payload_bytes integer NOT NULL,
  payload_sha256 text NOT NULL,
  source_checked_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL,
  checkpointed_at timestamptz NOT NULL,
  expected_next_check_at timestamptz,
  stale_at timestamptz,
  CONSTRAINT live_match_detail_checkpoints_pkey PRIMARY KEY (season_id, event_id),
  CONSTRAINT live_match_detail_checkpoints_event_fk
    FOREIGN KEY (season_id, event_id)
    REFERENCES fpl.events (season_id, event_id),
  CONSTRAINT live_match_detail_checkpoints_publication_once
    UNIQUE (season_id, event_id, publication_id),
  CONSTRAINT live_match_detail_checkpoints_identity_valid CHECK (
    event_id > 0
    AND generation > 0
    AND observed_desk_generation > 0
    AND publication_id ~ '^[0-9a-f-]{36}$'
    AND fixture_identity_revision ~ '^[0-9a-f]{64}$'
    AND state = ANY (ARRAY['PROVISIONAL', 'FINALIZED']::text[])
  ),
  CONSTRAINT live_match_detail_checkpoints_payload_valid CHECK (
    jsonb_typeof(manifest) = 'object'
    AND pg_column_size(manifest) <= 131072
    AND jsonb_typeof(revisions) = 'object'
    AND jsonb_typeof(payload) = 'array'
    AND row_count = jsonb_array_length(payload)
    AND row_count BETWEEN 0 AND 32
    AND payload_bytes BETWEEN 0 AND 2097152
    AND payload_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX live_match_detail_checkpoints_generation_idx
  ON fpl.live_match_detail_checkpoints (season_id, event_id, generation);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE fpl.live_match_desk_checkpoints TO letletme_data_writer;
GRANT SELECT ON TABLE fpl.live_match_desk_checkpoints TO letletme_graphql_reader;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE fpl.live_match_detail_checkpoints TO letletme_data_writer;
GRANT SELECT ON TABLE fpl.live_match_detail_checkpoints TO letletme_graphql_reader;

ALTER TABLE fpl.live_match_desk_checkpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY live_match_desk_checkpoints_data_writer_all
  ON fpl.live_match_desk_checkpoints
  FOR ALL TO letletme_data_writer
  USING (true)
  WITH CHECK (true);
CREATE POLICY live_match_desk_checkpoints_graphql_reader_select
  ON fpl.live_match_desk_checkpoints
  FOR SELECT TO letletme_graphql_reader
  USING (true);

ALTER TABLE fpl.live_match_detail_checkpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY live_match_detail_checkpoints_data_writer_all
  ON fpl.live_match_detail_checkpoints
  FOR ALL TO letletme_data_writer
  USING (true)
  WITH CHECK (true);
CREATE POLICY live_match_detail_checkpoints_graphql_reader_select
  ON fpl.live_match_detail_checkpoints
  FOR SELECT TO letletme_graphql_reader
  USING (true);
