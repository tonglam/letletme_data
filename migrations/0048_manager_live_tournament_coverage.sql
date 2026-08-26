-- Durable progress for tournament-scoped manager-live crawls.  Score rows
-- remain the authoritative data; this table only records whether the current
-- roster has been fully traversed for an event.

CREATE TABLE fpl.manager_live_tournament_coverage (
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  tournament_id integer NOT NULL,
  roster_revision text NOT NULL,
  expected_entries integer NOT NULL,
  resolved_entries integer NOT NULL,
  fully_fetched_at timestamptz,
  manager_revision text,
  error text,
  state text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT manager_live_tournament_coverage_pkey
    PRIMARY KEY (season_id, event_id, tournament_id),
  CONSTRAINT manager_live_tournament_coverage_event_fk
    FOREIGN KEY (season_id, event_id)
    REFERENCES fpl.events(season_id, event_id),
  CONSTRAINT manager_live_tournament_coverage_state_valid
    CHECK (state IN ('WARMING', 'COMPLETE', 'PARTIAL', 'UNAVAILABLE')),
  CONSTRAINT manager_live_tournament_coverage_counts_valid
    CHECK (expected_entries >= 0 AND resolved_entries >= 0 AND resolved_entries <= expected_entries),
  CONSTRAINT manager_live_tournament_coverage_ids_positive
    CHECK (event_id > 0 AND tournament_id > 0),
  CONSTRAINT manager_live_tournament_coverage_revision_nonempty
    CHECK (btrim(roster_revision) <> '')
);

CREATE INDEX manager_live_tournament_coverage_state_idx
  ON fpl.manager_live_tournament_coverage (season_id, event_id, state, updated_at DESC NULLS LAST);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE fpl.manager_live_tournament_coverage TO letletme_data_writer;
GRANT SELECT ON TABLE fpl.manager_live_tournament_coverage TO letletme_graphql_reader;
