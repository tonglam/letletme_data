CREATE TABLE IF NOT EXISTS competition.entry_event_pick_heads (
  season_id smallint NOT NULL,
  entry_id integer NOT NULL,
  event_id integer NOT NULL,
  publication_id text NOT NULL,
  generation bigint NOT NULL,
  picks_base_revision text NOT NULL,
  content_sha256 text NOT NULL,
  row_count smallint NOT NULL,
  source_checked_at timestamptz NOT NULL,
  content_updated_at timestamptz NOT NULL,
  checkpointed_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'COMPLETE',
  CONSTRAINT entry_event_pick_heads_pkey PRIMARY KEY (season_id, entry_id, event_id),
  CONSTRAINT entry_event_pick_heads_entry_fk
    FOREIGN KEY (season_id, entry_id)
    REFERENCES competition.entries (season_id, entry_id),
  CONSTRAINT entry_event_pick_heads_event_fk
    FOREIGN KEY (season_id, event_id)
    REFERENCES fpl.events (season_id, event_id),
  CONSTRAINT entry_event_pick_heads_identity_valid CHECK (
    entry_id > 0
    AND event_id > 0
    AND generation > 0
    AND row_count = 15
    AND state = 'COMPLETE'
    AND picks_base_revision ~ '^[0-9a-f]{64}$'
    AND content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT entry_event_pick_heads_time_order CHECK (
    checkpointed_at >= source_checked_at
  )
);

CREATE INDEX IF NOT EXISTS entry_event_pick_heads_event_entry_idx
  ON competition.entry_event_pick_heads (season_id, event_id, entry_id)
  INCLUDE (publication_id, generation, picks_base_revision, content_sha256, row_count, source_checked_at, content_updated_at, checkpointed_at, state);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE competition.entry_event_pick_heads TO letletme_data_writer;
GRANT SELECT ON TABLE competition.entry_event_pick_heads TO letletme_graphql_reader;
