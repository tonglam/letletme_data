-- Immutable projected manager scores. The existing manager_event_score_snapshots
-- table remains a rank checkpoint; these tables make score authority and the
-- active head explicit without mutating a previously validated input.
CREATE TABLE fpl.manager_event_score_materializations (
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  entry_id integer NOT NULL,
  input_revision text NOT NULL,
  score_revision text NOT NULL,
  calculation_mode text NOT NULL,
  algorithm_version text NOT NULL,
  score_source text NOT NULL,
  live_publication_id uuid NOT NULL,
  live_revision text NOT NULL,
  live_checked_at timestamptz NOT NULL,
  picks_revision text NOT NULL,
  picks_checked_at timestamptz NOT NULL,
  previous_totals_revision text NOT NULL,
  previous_totals_through_event_id integer,
  result_revision text,
  result_checked_at timestamptz,
  data_checked_at timestamptz,
  rank_revision text,
  rank_source text,
  rank_checked_at timestamptz,
  event_points integer NOT NULL,
  net_event_points integer NOT NULL,
  total_points integer,
  transfer_cost integer NOT NULL,
  effective_lineup jsonb NOT NULL,
  source_min_checked_at timestamptz NOT NULL,
  source_max_checked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT manager_event_score_materializations_pkey
    PRIMARY KEY (season_id, event_id, entry_id, input_revision),
  CONSTRAINT manager_event_score_materializations_event_fk
    FOREIGN KEY (season_id, event_id) REFERENCES fpl.events (season_id, event_id),
  CONSTRAINT manager_event_score_materializations_ids_positive
    CHECK (event_id > 0 AND entry_id > 0),
  CONSTRAINT manager_event_score_materializations_mode_valid
    CHECK (calculation_mode = 'PROJECTED_AUTOSUBS'),
  CONSTRAINT manager_event_score_materializations_source_valid
    CHECK (score_source = 'FPL_EVENT_LIVE'),
  CONSTRAINT manager_event_score_materializations_algorithm_valid
    CHECK (algorithm_version = 'fpl-projected-autosubs-v1'),
  CONSTRAINT manager_event_score_materializations_revision_nonempty
    CHECK (
      btrim(input_revision) <> '' AND btrim(score_revision) <> '' AND
      btrim(algorithm_version) <> '' AND btrim(live_revision) <> '' AND
      btrim(picks_revision) <> '' AND btrim(previous_totals_revision) <> ''
    ),
  CONSTRAINT manager_event_score_materializations_lineup_complete
    CHECK (jsonb_typeof(effective_lineup) = 'array' AND jsonb_array_length(effective_lineup) = 15),
  CONSTRAINT manager_event_score_materializations_points_reconcile
    CHECK (transfer_cost >= 0 AND net_event_points = event_points - transfer_cost),
  CONSTRAINT manager_event_score_materializations_source_span_valid
    CHECK (source_min_checked_at <= source_max_checked_at),
  CONSTRAINT manager_event_score_materializations_previous_event_valid
    CHECK (previous_totals_through_event_id IS NULL OR previous_totals_through_event_id >= 0),
  CONSTRAINT manager_event_score_materializations_rank_source_valid
    CHECK (rank_source IS NULL OR rank_source IN ('FPL_ENTRY_SUMMARY', 'FPL_CLASSIC_STANDINGS'))
);

CREATE INDEX manager_event_score_materializations_lookup_idx
  ON fpl.manager_event_score_materializations (season_id, event_id, entry_id, calculation_mode, created_at DESC NULLS LAST);

CREATE TABLE fpl.manager_event_score_heads (
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  entry_id integer NOT NULL,
  calculation_mode text NOT NULL,
  input_revision text NOT NULL,
  score_revision text NOT NULL,
  generation bigint NOT NULL,
  verified_live_revision text NOT NULL,
  verified_picks_revision text NOT NULL,
  verified_previous_totals_revision text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT manager_event_score_heads_pkey
    PRIMARY KEY (season_id, event_id, entry_id, calculation_mode),
  CONSTRAINT manager_event_score_heads_event_fk
    FOREIGN KEY (season_id, event_id) REFERENCES fpl.events (season_id, event_id),
  CONSTRAINT manager_event_score_heads_materialization_fk
    FOREIGN KEY (season_id, event_id, entry_id, input_revision)
    REFERENCES fpl.manager_event_score_materializations
      (season_id, event_id, entry_id, input_revision),
  CONSTRAINT manager_event_score_heads_ids_positive
    CHECK (event_id > 0 AND entry_id > 0),
  CONSTRAINT manager_event_score_heads_mode_valid
    CHECK (calculation_mode = 'PROJECTED_AUTOSUBS'),
  CONSTRAINT manager_event_score_heads_generation_positive CHECK (generation > 0),
  CONSTRAINT manager_event_score_heads_revision_nonempty
    CHECK (
      btrim(input_revision) <> '' AND btrim(score_revision) <> '' AND
      btrim(verified_live_revision) <> '' AND btrim(verified_picks_revision) <> '' AND
      btrim(verified_previous_totals_revision) <> ''
    )
);

CREATE INDEX manager_event_score_heads_generation_idx
  ON fpl.manager_event_score_heads (season_id, event_id, calculation_mode, generation DESC NULLS LAST);

GRANT SELECT, INSERT ON TABLE fpl.manager_event_score_materializations TO letletme_data_writer;
GRANT SELECT ON TABLE fpl.manager_event_score_materializations TO letletme_graphql_reader;
GRANT SELECT, INSERT, UPDATE ON TABLE fpl.manager_event_score_heads TO letletme_data_writer;
GRANT SELECT ON TABLE fpl.manager_event_score_heads TO letletme_graphql_reader;
