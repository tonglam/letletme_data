-- Redis-first live tournament publications.
--
-- A row is the latest complete cold checkpoint for one exact tournament/event
-- scope.  It is deliberately self-contained: Redis may be rebuilt without
-- joining a roster, entry input, or H2H match from a different revision.

CREATE TABLE competition.live_league_checkpoints (
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  tournament_id integer NOT NULL,
  scope_kind text NOT NULL,
  publication_id text NOT NULL,
  generation bigint NOT NULL,
  state text NOT NULL,
  manifest jsonb NOT NULL,
  index_payload jsonb NOT NULL,
  payload jsonb NOT NULL,
  row_count integer NOT NULL,
  payload_bytes integer NOT NULL,
  payload_sha256 text NOT NULL,
  source_checked_at timestamptz NOT NULL,
  content_updated_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL,
  checkpointed_at timestamptz NOT NULL,
  expected_next_check_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT live_league_checkpoints_pkey
    PRIMARY KEY (season_id, event_id, tournament_id, scope_kind),
  CONSTRAINT live_league_checkpoints_event_fk
    FOREIGN KEY (season_id, event_id)
    REFERENCES fpl.events (season_id, event_id),
  CONSTRAINT live_league_checkpoints_tournament_fk
    FOREIGN KEY (season_id, tournament_id)
    REFERENCES competition.tournaments (season_id, tournament_id),
  CONSTRAINT live_league_checkpoints_publication_once
    UNIQUE (season_id, event_id, tournament_id, scope_kind, publication_id),
  CONSTRAINT live_league_checkpoints_scope_kind_valid CHECK (
    scope_kind = ANY (ARRAY['CLASSIC', 'H2H_HEAD', 'H2H_STANDINGS']::text[])
  ),
  CONSTRAINT live_league_checkpoints_identity_valid CHECK (
    event_id > 0
    AND tournament_id > 0
    AND generation > 0
    AND btrim(publication_id) <> ''
    AND btrim(state) <> ''
  ),
  CONSTRAINT live_league_checkpoints_payload_valid CHECK (
    jsonb_typeof(manifest) = 'object'
    AND jsonb_typeof(index_payload) = 'array'
    AND jsonb_typeof(payload) = 'object'
    AND row_count >= 0
    AND payload_bytes >= 0
    AND payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT live_league_checkpoints_time_order CHECK (
    published_at >= source_checked_at
    AND checkpointed_at >= published_at
  )
);

CREATE INDEX live_league_checkpoints_generation_idx
  ON competition.live_league_checkpoints
    (season_id, event_id, tournament_id, generation);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE competition.live_league_checkpoints TO letletme_data_writer;
GRANT SELECT
  ON TABLE competition.live_league_checkpoints TO letletme_graphql_reader;

ALTER TABLE competition.live_league_checkpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY live_league_checkpoints_data_writer_all
  ON competition.live_league_checkpoints
  FOR ALL TO letletme_data_writer
  USING (true)
  WITH CHECK (true);
CREATE POLICY live_league_checkpoints_graphql_reader_select
  ON competition.live_league_checkpoints
  FOR SELECT TO letletme_graphql_reader
  USING (true);
