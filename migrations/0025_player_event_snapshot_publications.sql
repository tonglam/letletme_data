-- Publish Player Stats rows only with an immutable, complete-set header.
-- The header is the read-side quality gate: a row count or revision alone is
-- never sufficient to expose cumulative values to consumers.
CREATE SEQUENCE fpl.player_event_snapshot_publication_revision_seq
  AS bigint
  START WITH 1
  INCREMENT BY 1
  MINVALUE 1
  NO MAXVALUE
  CACHE 1;

ALTER SEQUENCE fpl.player_event_snapshot_publication_revision_seq
  OWNER TO letletme_data_owner;

CREATE TABLE fpl.player_event_snapshot_publications (
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  revision bigint NOT NULL DEFAULT nextval('fpl.player_event_snapshot_publication_revision_seq'::regclass),
  source_checked_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  row_count integer NOT NULL,
  expected_row_count integer NOT NULL,
  content_sha256 text NOT NULL,
  baseline_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_event_snapshot_publications_pkey PRIMARY KEY (season_id, event_id),
  CONSTRAINT player_event_snapshot_publications_season_fk
    FOREIGN KEY (season_id) REFERENCES fpl.seasons (season_id),
  CONSTRAINT player_event_snapshot_publications_event_fk
    FOREIGN KEY (season_id, event_id) REFERENCES fpl.events (season_id, event_id),
  CONSTRAINT player_event_snapshot_publications_revision_positive CHECK (revision > 0),
  CONSTRAINT player_event_snapshot_publications_counts_positive
    CHECK (row_count > 0 AND expected_row_count > 0),
  CONSTRAINT player_event_snapshot_publications_counts_complete
    CHECK (row_count = expected_row_count),
  CONSTRAINT player_event_snapshot_publications_hash_valid
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$')
);

ALTER TABLE fpl.player_event_snapshot_publications
  OWNER TO letletme_data_owner;

GRANT SELECT,INSERT,DELETE,UPDATE
  ON TABLE fpl.player_event_snapshot_publications TO letletme_data_writer;
GRANT SELECT
  ON TABLE fpl.player_event_snapshot_publications TO letletme_graphql_reader;
GRANT SELECT,USAGE
  ON SEQUENCE fpl.player_event_snapshot_publication_revision_seq TO letletme_data_writer;
