-- Live window state is independent from the immutable live publication
-- revision. A quiet interval therefore does not need to manufacture a new
-- publication just to tell readers that the window changed.

CREATE TABLE ops.live_lifecycle_status (
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  state text NOT NULL,
  observed_at timestamptz NOT NULL,
  last_changed_at timestamptz NOT NULL,
  next_refresh_at timestamptz,
  live_revision text,
  publication_id uuid,
  source_checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT live_lifecycle_status_pkey PRIMARY KEY (season_id, event_id),
  CONSTRAINT live_lifecycle_status_event_fk
    FOREIGN KEY (season_id, event_id)
    REFERENCES fpl.events(season_id, event_id),
  CONSTRAINT live_lifecycle_status_state_valid
    CHECK (state IN (
      'PRE_DEADLINE', 'PICKS_WAIT', 'PICKS_PROBE', 'PICKS_SYNC',
      'LIVE_ACTIVE', 'BETWEEN_FIXTURES', 'DAY_SETTLING', 'GW_REVIEW',
      'FINALIZED'
    ))
);

CREATE INDEX live_lifecycle_status_refresh_idx
  ON ops.live_lifecycle_status (next_refresh_at, state);

CREATE TABLE fpl.manager_event_score_snapshots (
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  scope_type text NOT NULL,
  scope_id integer NOT NULL,
  entry_id integer NOT NULL,
  event_points integer,
  net_event_points integer,
  total_points integer,
  total_scope text NOT NULL,
  event_rank integer,
  overall_rank integer,
  league_rank integer,
  source text NOT NULL,
  transfer_cost integer,
  event_point_semantics text NOT NULL,
  content_revision text NOT NULL,
  checked_at timestamptz NOT NULL,
  upstream_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT manager_event_score_snapshots_pkey
    PRIMARY KEY (season_id, event_id, scope_type, scope_id, entry_id),
  CONSTRAINT manager_event_score_snapshots_event_fk
    FOREIGN KEY (season_id, event_id)
    REFERENCES fpl.events(season_id, event_id),
  CONSTRAINT manager_event_score_snapshots_scope_valid
    CHECK (
      (scope_type = 'ENTRY' AND scope_id = 0)
      OR (scope_type = 'CLASSIC_LEAGUE' AND scope_id > 0)
    ),
  CONSTRAINT manager_event_score_snapshots_ids_positive
    CHECK (event_id > 0 AND entry_id > 0),
  CONSTRAINT manager_event_score_snapshots_source_valid
    CHECK (source IN ('FPL_ENTRY_SUMMARY', 'FPL_CLASSIC_STANDINGS', 'FPL_FINAL_RESULT')),
  CONSTRAINT manager_event_score_snapshots_scope_total_valid
    CHECK (total_scope IN ('OVERALL', 'CLASSIC_PHASE')),
  CONSTRAINT manager_event_score_snapshots_semantics_valid
    CHECK (event_point_semantics IN ('GROSS', 'NET', 'ZERO_COST_EQUIVALENT', 'UNKNOWN')),
  CONSTRAINT manager_event_score_snapshots_revision_nonempty
    CHECK (btrim(content_revision) <> '')
);

CREATE INDEX manager_event_score_snapshots_entry_idx
  ON fpl.manager_event_score_snapshots (season_id, event_id, entry_id, checked_at DESC);

CREATE INDEX manager_event_score_snapshots_scope_idx
  ON fpl.manager_event_score_snapshots (season_id, event_id, scope_type, scope_id, checked_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE ops.live_lifecycle_status TO letletme_data_writer;
GRANT SELECT ON TABLE ops.live_lifecycle_status TO letletme_graphql_reader;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE fpl.manager_event_score_snapshots TO letletme_data_writer;
GRANT SELECT ON TABLE fpl.manager_event_score_snapshots TO letletme_graphql_reader;
