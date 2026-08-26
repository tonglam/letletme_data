CREATE TABLE competition.tournament_official_h2h_page_manifests (
  season_id smallint NOT NULL,
  tournament_id integer NOT NULL,
  page_number integer NOT NULL,
  schedule_hash text NOT NULL,
  match_ids integer[] NOT NULL,
  event_ids integer[] NOT NULL,
  immutable_page_hash text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_at timestamptz,
  PRIMARY KEY (season_id, tournament_id, page_number),
  CONSTRAINT tournament_h2h_manifest_tournament_fk
    FOREIGN KEY (season_id, tournament_id)
    REFERENCES competition.tournaments (season_id, tournament_id)
    ON DELETE CASCADE,
  CONSTRAINT tournament_h2h_manifest_page_positive CHECK (page_number > 0),
  CONSTRAINT tournament_h2h_manifest_schedule_hash CHECK (schedule_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tournament_h2h_manifest_immutable_hash CHECK (immutable_page_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tournament_h2h_manifest_match_ids_nonempty CHECK (cardinality(match_ids) > 0),
  CONSTRAINT tournament_h2h_manifest_event_ids_nonempty CHECK (cardinality(event_ids) > 0),
  -- Keep the database fence as well as the repository validation. The
  -- delimiter form avoids a subquery (which CHECK expressions cannot use),
  -- while rejecting NULL, zero and negative element IDs.
  CONSTRAINT tournament_h2h_manifest_match_ids_positive CHECK (
    array_position(match_ids, NULL) IS NULL
    AND array_to_string(match_ids, ',') ~ '^[1-9][0-9]*(,[1-9][0-9]*)*$'
  ),
  CONSTRAINT tournament_h2h_manifest_event_ids_positive CHECK (
    array_position(event_ids, NULL) IS NULL
    AND array_to_string(event_ids, ',') ~ '^[1-9][0-9]*(,[1-9][0-9]*)*$'
  ),
  CONSTRAINT tournament_h2h_manifest_arrays_1d CHECK (
    array_ndims(match_ids) = 1 AND array_ndims(event_ids) = 1
  )
);

CREATE INDEX tournament_h2h_manifest_event_idx
  ON competition.tournament_official_h2h_page_manifests (season_id, tournament_id)
  WHERE locked_at IS NOT NULL;

REVOKE ALL ON TABLE competition.tournament_official_h2h_page_manifests FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE competition.tournament_official_h2h_page_manifests TO letletme_data_writer;
REVOKE ALL ON TABLE competition.tournament_official_h2h_page_manifests FROM letletme_graphql_reader;
