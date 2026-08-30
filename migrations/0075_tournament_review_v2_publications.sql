-- My Tournament Review V2 publishes one finalized, immutable read model per
-- (season, tournament, event). PostgreSQL remains the business authority;
-- consumers may cache a revision, but they must resolve it through the head.

CREATE TABLE competition.tournament_review_publications (
  season_id smallint NOT NULL,
  tournament_id integer NOT NULL,
  event_id integer NOT NULL,
  revision bigint NOT NULL,
  format text NOT NULL,
  schema_version text NOT NULL DEFAULT 'my-tournament-review-v2',
  metric_version text NOT NULL DEFAULT 'descriptive-v1',
  event_data_checked_at timestamptz NOT NULL,
  source_min_checked_at timestamptz NOT NULL,
  source_max_checked_at timestamptz NOT NULL,
  expected_subject_count integer NOT NULL,
  ready_subject_count integer NOT NULL,
  not_applicable_subject_count integer NOT NULL DEFAULT 0,
  row_count integer NOT NULL,
  content_sha256 text NOT NULL,
  payload jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tournament_review_publications_pkey
    PRIMARY KEY (season_id, tournament_id, event_id, revision),
  CONSTRAINT tournament_review_publications_tournament_fk
    FOREIGN KEY (season_id, tournament_id)
    REFERENCES competition.tournaments(season_id, tournament_id)
    ON DELETE CASCADE,
  CONSTRAINT tournament_review_publications_event_fk
    FOREIGN KEY (season_id, event_id)
    REFERENCES fpl.events(season_id, event_id),
  CONSTRAINT tournament_review_publications_revision_positive
    CHECK (revision > 0),
  CONSTRAINT tournament_review_publications_format_check
    CHECK (format IN ('POINTS', 'H2H', 'KNOCKOUT')),
  CONSTRAINT tournament_review_publications_versions_check
    CHECK (
      schema_version = 'my-tournament-review-v2'
      AND metric_version = 'descriptive-v1'
    ),
  CONSTRAINT tournament_review_publications_counts_check
    CHECK (
      expected_subject_count >= 0
      AND ready_subject_count >= 0
      AND not_applicable_subject_count >= 0
      AND ready_subject_count + not_applicable_subject_count = expected_subject_count
      AND row_count >= 0
    ),
  CONSTRAINT tournament_review_publications_hash_check
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tournament_review_publications_payload_check
    CHECK (
      jsonb_typeof(payload) = 'object'
      AND payload ->> 'schemaVersion' = schema_version
      AND payload ->> 'metricVersion' = metric_version
      AND payload ->> 'format' = format
      AND (
        (format = 'POINTS' AND payload ? 'points' AND NOT (payload ? 'h2h') AND NOT (payload ? 'knockout'))
        OR (format = 'H2H' AND payload ? 'h2h' AND NOT (payload ? 'points') AND NOT (payload ? 'knockout'))
        OR (format = 'KNOCKOUT' AND payload ? 'knockout' AND NOT (payload ? 'points') AND NOT (payload ? 'h2h'))
      )
    ),
  CONSTRAINT tournament_review_publications_source_span_check
    CHECK (
      source_min_checked_at <= event_data_checked_at
      AND event_data_checked_at <= source_max_checked_at
      AND source_max_checked_at <= published_at
    )
);

CREATE UNIQUE INDEX tournament_review_publications_content_unique
  ON competition.tournament_review_publications
    (season_id, tournament_id, event_id, content_sha256);

CREATE INDEX tournament_review_publications_retention_idx
  ON competition.tournament_review_publications
    (season_id, tournament_id, event_id, published_at DESC NULLS LAST);

CREATE TABLE competition.tournament_review_heads (
  season_id smallint NOT NULL,
  tournament_id integer NOT NULL,
  event_id integer NOT NULL,
  revision bigint NOT NULL,
  content_sha256 text NOT NULL,
  published_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tournament_review_heads_pkey
    PRIMARY KEY (season_id, tournament_id, event_id),
  CONSTRAINT tournament_review_heads_publication_fk
    FOREIGN KEY (season_id, tournament_id, event_id, revision)
    REFERENCES competition.tournament_review_publications
      (season_id, tournament_id, event_id, revision)
    ON DELETE CASCADE,
  CONSTRAINT tournament_review_heads_hash_check
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX tournament_review_heads_tournament_event_idx
  ON competition.tournament_review_heads
    (season_id, tournament_id, event_id DESC NULLS LAST);

CREATE TABLE competition.tournament_review_obligations (
  season_id smallint NOT NULL,
  tournament_id integer NOT NULL,
  event_id integer NOT NULL,
  format text NOT NULL,
  state text NOT NULL DEFAULT 'PENDING',
  eligible_at timestamptz NOT NULL,
  next_attempt_at timestamptz,
  execution_attempts integer NOT NULL DEFAULT 0,
  source_rechecks integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  first_attempt_at timestamptz,
  last_attempt_at timestamptz,
  ready_at timestamptz,
  degraded_at timestamptz,
  ready_revision bigint,
  last_error_code text,
  last_failure_fingerprint text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tournament_review_obligations_pkey
    PRIMARY KEY (season_id, tournament_id, event_id),
  CONSTRAINT tournament_review_obligations_tournament_fk
    FOREIGN KEY (season_id, tournament_id)
    REFERENCES competition.tournaments(season_id, tournament_id)
    ON DELETE CASCADE,
  CONSTRAINT tournament_review_obligations_event_fk
    FOREIGN KEY (season_id, event_id)
    REFERENCES fpl.events(season_id, event_id),
  CONSTRAINT tournament_review_obligations_ready_publication_fk
    FOREIGN KEY (season_id, tournament_id, event_id, ready_revision)
    REFERENCES competition.tournament_review_publications
      (season_id, tournament_id, event_id, revision)
    ON DELETE CASCADE,
  CONSTRAINT tournament_review_obligations_format_check
    CHECK (format IN ('POINTS', 'H2H', 'KNOCKOUT')),
  CONSTRAINT tournament_review_obligations_state_check
    CHECK (state IN ('PENDING', 'WAITING_SOURCE', 'PROCESSING', 'READY', 'DEGRADED')),
  CONSTRAINT tournament_review_obligations_attempts_check
    CHECK (execution_attempts >= 0 AND source_rechecks >= 0),
  CONSTRAINT tournament_review_obligations_lease_check
    CHECK (
      (lease_owner IS NULL AND lease_expires_at IS NULL)
      OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
  CONSTRAINT tournament_review_obligations_ready_check
    CHECK (
      (state = 'READY' AND ready_at IS NOT NULL AND ready_revision IS NOT NULL)
      OR (state <> 'READY' AND ready_revision IS NULL)
    ),
  CONSTRAINT tournament_review_obligations_fingerprint_check
    CHECK (
      last_failure_fingerprint IS NULL
      OR last_failure_fingerprint ~ '^[0-9a-f]{64}$'
    )
);

CREATE INDEX tournament_review_obligations_due_idx
  ON competition.tournament_review_obligations
    (next_attempt_at, season_id, tournament_id, event_id)
  WHERE state IN ('PENDING', 'WAITING_SOURCE', 'DEGRADED')
    AND next_attempt_at IS NOT NULL;

CREATE INDEX tournament_review_obligations_reclaim_idx
  ON competition.tournament_review_obligations
    (lease_expires_at, season_id, tournament_id, event_id)
  WHERE state = 'PROCESSING';

-- Reconciliation performs only post-watermark range probes for existing
-- scopes. These indexes keep the five-minute poll proportional to changed
-- source rows rather than season history.
CREATE INDEX tournament_review_entry_results_reconcile_idx
  ON competition.entry_event_results
    (season_id, entry_id,
     (GREATEST(updated_at, COALESCE(rich_synced_at, '-infinity'::timestamptz))),
     event_id);

CREATE INDEX tournament_review_points_results_reconcile_idx
  ON competition.tournament_points_group_results
    (season_id, tournament_id, updated_at, event_id);

CREATE INDEX tournament_review_h2h_results_reconcile_idx
  ON competition.tournament_battle_group_results
    (season_id, tournament_id, updated_at, event_id);

CREATE INDEX tournament_review_knockout_results_reconcile_idx
  ON competition.tournament_knockout_results
    (season_id, tournament_id, updated_at, event_id);

CREATE INDEX tournament_review_knockout_brackets_reconcile_idx
  ON competition.tournament_knockouts
    (season_id, tournament_id, updated_at, started_event_id, ended_event_id);

CREATE INDEX tournament_review_entries_reconcile_idx
  ON competition.entries (season_id, updated_at, entry_id);

REVOKE ALL ON TABLE
  competition.tournament_review_publications,
  competition.tournament_review_heads,
  competition.tournament_review_obligations
FROM PUBLIC;

GRANT SELECT, INSERT ON TABLE competition.tournament_review_publications
TO letletme_data_writer;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  competition.tournament_review_heads,
  competition.tournament_review_obligations
TO letletme_data_writer;

GRANT SELECT ON TABLE
  competition.tournament_review_publications,
  competition.tournament_review_heads,
  competition.tournament_review_obligations
TO letletme_graphql_reader;

ALTER TABLE competition.tournament_review_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE competition.tournament_review_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE competition.tournament_review_obligations ENABLE ROW LEVEL SECURITY;

CREATE POLICY tournament_review_publications_writer_insert
  ON competition.tournament_review_publications
  FOR INSERT TO letletme_data_writer WITH CHECK (true);
CREATE POLICY tournament_review_publications_writer_select
  ON competition.tournament_review_publications
  FOR SELECT TO letletme_data_writer USING (true);
CREATE POLICY tournament_review_heads_writer_insert
  ON competition.tournament_review_heads
  FOR INSERT TO letletme_data_writer WITH CHECK (true);
CREATE POLICY tournament_review_heads_writer_select
  ON competition.tournament_review_heads
  FOR SELECT TO letletme_data_writer USING (true);
CREATE POLICY tournament_review_heads_writer_update
  ON competition.tournament_review_heads
  FOR UPDATE TO letletme_data_writer USING (true) WITH CHECK (true);
CREATE POLICY tournament_review_heads_writer_delete
  ON competition.tournament_review_heads
  FOR DELETE TO letletme_data_writer USING (true);
CREATE POLICY tournament_review_obligations_writer_insert
  ON competition.tournament_review_obligations
  FOR INSERT TO letletme_data_writer WITH CHECK (true);
CREATE POLICY tournament_review_obligations_writer_select
  ON competition.tournament_review_obligations
  FOR SELECT TO letletme_data_writer USING (true);
CREATE POLICY tournament_review_obligations_writer_update
  ON competition.tournament_review_obligations
  FOR UPDATE TO letletme_data_writer USING (true) WITH CHECK (true);
CREATE POLICY tournament_review_obligations_writer_delete
  ON competition.tournament_review_obligations
  FOR DELETE TO letletme_data_writer USING (true);

CREATE POLICY tournament_review_publications_reader_select
  ON competition.tournament_review_publications
  FOR SELECT TO letletme_graphql_reader USING (true);
CREATE POLICY tournament_review_heads_reader_select
  ON competition.tournament_review_heads
  FOR SELECT TO letletme_graphql_reader USING (true);
CREATE POLICY tournament_review_obligations_reader_select
  ON competition.tournament_review_obligations
  FOR SELECT TO letletme_graphql_reader USING (true);

COMMENT ON TABLE competition.tournament_review_publications IS
  'Immutable finalized My Tournament Review V2 payloads scoped by season, tournament and event.';
COMMENT ON TABLE competition.tournament_review_heads IS
  'Atomic product-visible revision pointers for My Tournament Review V2.';
COMMENT ON TABLE competition.tournament_review_obligations IS
  'Durable generation and repair state for finalized tournament review scopes.';
