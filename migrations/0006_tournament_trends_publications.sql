-- Trends publication read model.  Each tournament/event is published independently
-- so one incomplete or failed scope cannot make every public trend unavailable.
CREATE TABLE reporting.tournament_selection_stat_publications (
  publication_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  season_id smallint NOT NULL,
  tournament_id integer NOT NULL,
  event_id integer NOT NULL,
  revision bigint NOT NULL,
  publication_state text NOT NULL DEFAULT 'COLLECTING',
  is_active boolean NOT NULL DEFAULT false,
  method_key text NOT NULL DEFAULT 'exact_prepared_competition',
  method_version text NOT NULL DEFAULT '1',
  source_policy_version text NOT NULL DEFAULT '1',
  source_watermark timestamptz,
  source_checksum text,
  expected_entries integer NOT NULL DEFAULT 0,
  complete_pick_entries integer NOT NULL DEFAULT 0,
  transfer_checkpoint_entries integer NOT NULL DEFAULT 0,
  ownership_state text NOT NULL DEFAULT 'NOT_READY',
  captaincy_state text NOT NULL DEFAULT 'NOT_READY',
  vice_captaincy_state text NOT NULL DEFAULT 'NOT_READY',
  transfers_state text NOT NULL DEFAULT 'NOT_READY',
  captured_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tournament_selection_stat_publications_scope_revision_unique
    UNIQUE (season_id, tournament_id, event_id, revision),
  CONSTRAINT tournament_selection_stat_publications_scope_fk
    FOREIGN KEY (season_id, tournament_id)
    REFERENCES competition.tournaments (season_id, tournament_id)
    ON DELETE CASCADE,
  CONSTRAINT tournament_selection_stat_publications_event_fk
    FOREIGN KEY (season_id, event_id)
    REFERENCES fpl.events (season_id, event_id),
  CONSTRAINT tournament_selection_stat_publications_ids_positive
    CHECK (tournament_id > 0 AND event_id BETWEEN 1 AND 38 AND revision > 0),
  CONSTRAINT tournament_selection_stat_publications_counts_nonnegative
    CHECK (expected_entries >= 0 AND complete_pick_entries >= 0 AND transfer_checkpoint_entries >= 0),
  CONSTRAINT tournament_selection_stat_publications_state_check
    CHECK (publication_state IN ('COLLECTING', 'READY', 'FAILED', 'UNSUPPORTED')),
  CONSTRAINT tournament_selection_stat_publications_capability_state_check
    CHECK (
      ownership_state IN ('READY', 'NOT_READY', 'FAILED', 'UNSUPPORTED')
      AND captaincy_state IN ('READY', 'NOT_READY', 'FAILED', 'UNSUPPORTED')
      AND vice_captaincy_state IN ('READY', 'NOT_READY', 'FAILED', 'UNSUPPORTED')
      AND transfers_state IN ('READY', 'NOT_READY', 'FAILED', 'UNSUPPORTED')
    )
);

CREATE UNIQUE INDEX tournament_selection_stat_publications_active_scope_idx
  ON reporting.tournament_selection_stat_publications (season_id, tournament_id, event_id)
  WHERE is_active;

CREATE INDEX tournament_selection_stat_publications_catalog_idx
  ON reporting.tournament_selection_stat_publications
    (season_id, tournament_id, event_id, publication_state, published_at DESC);

CREATE TABLE reporting.tournament_selection_stat_rows (
  publication_id bigint NOT NULL,
  element_id integer NOT NULL,
  selected_count integer NOT NULL DEFAULT 0,
  effective_selection_count integer NOT NULL DEFAULT 0,
  captain_count integer NOT NULL DEFAULT 0,
  vice_captain_count integer NOT NULL DEFAULT 0,
  transfer_in_count integer,
  transfer_out_count integer,
  player_name text NOT NULL,
  player_position integer NOT NULL,
  team_short_name text NOT NULL,
  CONSTRAINT tournament_selection_stat_rows_pkey PRIMARY KEY (publication_id, element_id),
  CONSTRAINT tournament_selection_stat_rows_publication_fk
    FOREIGN KEY (publication_id)
    REFERENCES reporting.tournament_selection_stat_publications (publication_id)
    ON DELETE CASCADE,
  CONSTRAINT tournament_selection_stat_rows_element_id_positive CHECK (element_id > 0),
  CONSTRAINT tournament_selection_stat_rows_counts_nonnegative CHECK (
    selected_count >= 0 AND effective_selection_count >= 0 AND captain_count >= 0
    AND vice_captain_count >= 0
    AND (transfer_in_count IS NULL OR transfer_in_count >= 0)
    AND (transfer_out_count IS NULL OR transfer_out_count >= 0)
  ),
  CONSTRAINT tournament_selection_stat_rows_player_name_nonempty CHECK (btrim(player_name) <> ''),
  CONSTRAINT tournament_selection_stat_rows_team_name_nonempty CHECK (btrim(team_short_name) <> '')
);

CREATE INDEX tournament_selection_stat_rows_ownership_idx
  ON reporting.tournament_selection_stat_rows (publication_id, selected_count DESC, element_id);
CREATE INDEX tournament_selection_stat_rows_effective_ownership_idx
  ON reporting.tournament_selection_stat_rows (publication_id, effective_selection_count DESC, element_id);
CREATE INDEX tournament_selection_stat_rows_captaincy_idx
  ON reporting.tournament_selection_stat_rows (publication_id, captain_count DESC, element_id);
CREATE INDEX tournament_selection_stat_rows_vice_captaincy_idx
  ON reporting.tournament_selection_stat_rows (publication_id, vice_captain_count DESC, element_id);
CREATE INDEX tournament_selection_stat_rows_transfer_in_idx
  ON reporting.tournament_selection_stat_rows (publication_id, transfer_in_count DESC NULLS LAST, element_id);
CREATE INDEX tournament_selection_stat_rows_transfer_out_idx
  ON reporting.tournament_selection_stat_rows (publication_id, transfer_out_count DESC NULLS LAST, element_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON reporting.tournament_selection_stat_publications TO letletme_data_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON reporting.tournament_selection_stat_rows TO letletme_data_writer;
GRANT USAGE, SELECT ON SEQUENCE reporting.tournament_selection_stat_publications_publication_id_seq TO letletme_data_writer;
GRANT SELECT ON reporting.tournament_selection_stat_publications TO letletme_graphql_reader;
GRANT SELECT ON reporting.tournament_selection_stat_rows TO letletme_graphql_reader;
