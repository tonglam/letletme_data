-- Redis-first Live Points V2 global checkpoint.
--
-- This relation is intentionally separate from ops.dataset_publications.  It
-- is the complete same-event PostgreSQL fallback for the GraphQL projection,
-- not a generic publication registry.  The primary key is the checkpoint
-- head; the writer refuses to supersede a FINALIZED row.
CREATE TABLE competition.live_points_publication_checkpoints (
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  publication_id text NOT NULL,
  generation bigint NOT NULL,
  state text NOT NULL,
  source_checked_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL,
  checkpointed_at timestamptz NOT NULL,
  expected_next_check_at timestamptz,
  revisions jsonb NOT NULL,
  event_live jsonb NOT NULL,
  fixtures jsonb NOT NULL,
  event_live_bytes integer NOT NULL,
  fixtures_bytes integer NOT NULL,
  event_live_sha256 text NOT NULL,
  fixtures_sha256 text NOT NULL,
  event_live_count integer NOT NULL,
  fixtures_count integer NOT NULL,
  CONSTRAINT live_points_publication_checkpoints_pkey PRIMARY KEY (season_id, event_id),
  CONSTRAINT live_points_publication_checkpoints_event_fk
    FOREIGN KEY (season_id, event_id)
    REFERENCES fpl.events (season_id, event_id),
  CONSTRAINT live_points_publication_checkpoints_publication_once
    UNIQUE (season_id, event_id, publication_id),
  CONSTRAINT live_points_publication_checkpoints_identity_valid CHECK (
    event_id > 0
    AND generation > 0
    AND publication_id ~ '^[0-9a-f-]{36}$'
    AND state = ANY (ARRAY[
      'PRE_DEADLINE', 'PICKS_WAIT', 'PICKS_PROBE', 'PICKS_SYNC',
      'LIVE_ACTIVE', 'BETWEEN_FIXTURES', 'DAY_SETTLING', 'GW_REVIEW',
      'FINALIZED'
    ]::text[])
  ),
  CONSTRAINT live_points_publication_checkpoints_payload_valid CHECK (
    jsonb_typeof(revisions) = 'object'
    AND jsonb_typeof(event_live) = 'array'
    AND jsonb_typeof(fixtures) = 'array'
    AND event_live_count = jsonb_array_length(event_live)
    AND fixtures_count = jsonb_array_length(fixtures)
    AND event_live_count >= 0
    AND fixtures_count >= 0
    AND event_live_bytes >= 0
    AND fixtures_bytes >= 0
    AND event_live_sha256 ~ '^[0-9a-f]{64}$'
    AND fixtures_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT live_points_publication_checkpoints_time_order CHECK (
    published_at >= source_checked_at
    AND checkpointed_at >= published_at
  )
);

CREATE INDEX live_points_publication_checkpoints_event_generation_idx
  ON competition.live_points_publication_checkpoints (season_id, event_id, generation);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE competition.live_points_publication_checkpoints TO letletme_data_writer;
GRANT SELECT ON TABLE competition.live_points_publication_checkpoints TO letletme_graphql_reader;
