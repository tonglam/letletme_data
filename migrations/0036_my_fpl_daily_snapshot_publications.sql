-- My FPL is a read model of one coherent publication per gameweek.  The
-- canonical FPL tables remain mutable for Live and reconciliation; these
-- tables are the product read boundary and are switched atomically.
CREATE SEQUENCE competition.my_fpl_snapshot_revision_seq
  AS bigint
  START WITH 1
  INCREMENT BY 1
  MINVALUE 1
  NO MAXVALUE
  CACHE 1;

ALTER SEQUENCE competition.my_fpl_snapshot_revision_seq
  OWNER TO letletme_data_owner;

CREATE TABLE competition.my_fpl_snapshot_publications (
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  revision bigint NOT NULL DEFAULT nextval('competition.my_fpl_snapshot_revision_seq'::regclass),
  snapshot_date date NOT NULL,
  source_checked_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  expected_entry_count integer NOT NULL,
  ready_entry_count integer NOT NULL,
  empty_entry_count integer NOT NULL,
  expected_tournament_count integer NOT NULL,
  ready_tournament_count integer NOT NULL,
  content_sha256 text NOT NULL,
  override_actor text,
  override_reason text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT my_fpl_snapshot_publications_pkey PRIMARY KEY (season_id, event_id, revision),
  CONSTRAINT my_fpl_snapshot_publications_season_fk
    FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id),
  CONSTRAINT my_fpl_snapshot_publications_event_fk
    FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id),
  CONSTRAINT my_fpl_snapshot_publications_kind_check
    CHECK (kind = ANY (ARRAY['PROVISIONAL'::text, 'FINAL'::text])),
  CONSTRAINT my_fpl_snapshot_publications_counts_check
    CHECK (expected_entry_count >= 0 AND ready_entry_count >= 0 AND empty_entry_count >= 0
      AND ready_entry_count + empty_entry_count = expected_entry_count
      AND expected_tournament_count >= 0 AND ready_tournament_count >= 0
      AND ready_tournament_count <= expected_tournament_count),
  CONSTRAINT my_fpl_snapshot_publications_hash_check
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$'::text),
  CONSTRAINT my_fpl_snapshot_publications_override_check
    CHECK ((override_actor IS NULL AND override_reason IS NULL AND idempotency_key IS NULL)
      OR (kind = 'FINAL'::text AND override_actor IS NOT NULL AND override_reason IS NOT NULL
          AND idempotency_key IS NOT NULL AND btrim(override_actor) <> '' AND btrim(override_reason) <> ''
          AND btrim(idempotency_key) <> ''))
);

CREATE UNIQUE INDEX my_fpl_snapshot_publications_active_key
  ON competition.my_fpl_snapshot_publications(season_id, event_id)
  WHERE active;

CREATE UNIQUE INDEX my_fpl_snapshot_publications_idempotency_key
  ON competition.my_fpl_snapshot_publications(season_id, event_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX my_fpl_snapshot_publications_gc_idx
  ON competition.my_fpl_snapshot_publications(season_id, event_id, published_at DESC);

-- The database switch and the Redis manifest handoff are one durable unit:
-- GraphQL reads the projection tables, while the outbox lets Redis recover
-- the same revision after a worker/process restart without ever leading an
-- uncommitted publication.
CREATE TABLE competition.my_fpl_snapshot_publication_outbox (
  outbox_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  revision bigint NOT NULL,
  manifest jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT my_fpl_snapshot_publication_outbox_scope_fk
    FOREIGN KEY (season_id, event_id, revision)
    REFERENCES competition.my_fpl_snapshot_publications(season_id, event_id, revision)
    ON DELETE CASCADE,
  CONSTRAINT my_fpl_snapshot_publication_outbox_status_check
    CHECK (status = ANY (ARRAY['PENDING'::text, 'PROCESSING'::text, 'DELIVERED'::text, 'SUPERSEDED'::text, 'FAILED'::text])),
  CONSTRAINT my_fpl_snapshot_publication_outbox_attempts_check
    CHECK (attempts >= 0),
  CONSTRAINT my_fpl_snapshot_publication_outbox_manifest_check
    CHECK (jsonb_typeof(manifest) = 'object'::text),
  CONSTRAINT my_fpl_snapshot_publication_outbox_lease_check
    CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL)
      OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE UNIQUE INDEX my_fpl_snapshot_publication_outbox_revision_key
  ON competition.my_fpl_snapshot_publication_outbox(season_id, event_id, revision);

CREATE INDEX my_fpl_snapshot_publication_outbox_pending_idx
  ON competition.my_fpl_snapshot_publication_outbox(available_at, outbox_id)
  WHERE status IN ('PENDING', 'PROCESSING') AND delivered_at IS NULL;

CREATE INDEX my_fpl_snapshot_publication_outbox_reclaim_idx
  ON competition.my_fpl_snapshot_publication_outbox(lease_expires_at, outbox_id)
  WHERE status = 'PROCESSING' AND delivered_at IS NULL;

CREATE TABLE competition.my_fpl_snapshot_entries (
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  revision bigint NOT NULL,
  entry_id integer NOT NULL,
  picks_count integer NOT NULL,
  is_empty boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT my_fpl_snapshot_entries_pkey PRIMARY KEY (season_id, event_id, revision, entry_id),
  CONSTRAINT my_fpl_snapshot_entries_publication_fk
    FOREIGN KEY (season_id, event_id, revision)
    REFERENCES competition.my_fpl_snapshot_publications(season_id, event_id, revision)
    ON DELETE CASCADE,
  CONSTRAINT my_fpl_snapshot_entries_entry_fk
    FOREIGN KEY (season_id, entry_id) REFERENCES competition.entries(season_id, entry_id),
  CONSTRAINT my_fpl_snapshot_entries_picks_check CHECK (picks_count >= 0 AND picks_count <= 15),
  CONSTRAINT my_fpl_snapshot_entries_payload_check CHECK (jsonb_typeof(payload) = 'object'::text)
);

CREATE INDEX my_fpl_snapshot_entries_active_lookup_idx
  ON competition.my_fpl_snapshot_entries(season_id, event_id, entry_id, revision DESC);

CREATE TABLE competition.my_fpl_snapshot_tournament_rows (
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  revision bigint NOT NULL,
  tournament_id integer NOT NULL,
  entry_id integer NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT my_fpl_snapshot_tournament_rows_pkey
    PRIMARY KEY (season_id, event_id, revision, tournament_id, entry_id),
  CONSTRAINT my_fpl_snapshot_tournament_rows_publication_fk
    FOREIGN KEY (season_id, event_id, revision)
    REFERENCES competition.my_fpl_snapshot_publications(season_id, event_id, revision)
    ON DELETE CASCADE,
  CONSTRAINT my_fpl_snapshot_tournament_rows_entry_fk
    FOREIGN KEY (season_id, entry_id) REFERENCES competition.entries(season_id, entry_id),
  CONSTRAINT my_fpl_snapshot_tournament_rows_tournament_fk
    FOREIGN KEY (season_id, tournament_id)
    REFERENCES competition.tournaments(season_id, tournament_id),
  CONSTRAINT my_fpl_snapshot_tournament_rows_payload_check
    CHECK (jsonb_typeof(payload) = 'object'::text)
);

CREATE INDEX my_fpl_snapshot_tournament_rows_board_idx
  ON competition.my_fpl_snapshot_tournament_rows
    (season_id, event_id, tournament_id, revision, entry_id);

CREATE TABLE competition.my_fpl_snapshot_tournament_aggregates (
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  revision bigint NOT NULL,
  tournament_id integer NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT my_fpl_snapshot_tournament_aggregates_pkey
    PRIMARY KEY (season_id, event_id, revision, tournament_id),
  CONSTRAINT my_fpl_snapshot_tournament_aggregates_publication_fk
    FOREIGN KEY (season_id, event_id, revision)
    REFERENCES competition.my_fpl_snapshot_publications(season_id, event_id, revision)
    ON DELETE CASCADE,
  CONSTRAINT my_fpl_snapshot_tournament_aggregates_tournament_fk
    FOREIGN KEY (season_id, tournament_id)
    REFERENCES competition.tournaments(season_id, tournament_id),
  CONSTRAINT my_fpl_snapshot_tournament_aggregates_payload_check
    CHECK (jsonb_typeof(payload) = 'object'::text)
);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE competition.my_fpl_snapshot_publications,
             competition.my_fpl_snapshot_entries,
             competition.my_fpl_snapshot_tournament_rows,
             competition.my_fpl_snapshot_tournament_aggregates,
             competition.my_fpl_snapshot_publication_outbox
  TO letletme_data_writer;
GRANT SELECT
  ON TABLE competition.my_fpl_snapshot_publications,
             competition.my_fpl_snapshot_entries,
             competition.my_fpl_snapshot_tournament_rows,
             competition.my_fpl_snapshot_tournament_aggregates,
             competition.my_fpl_snapshot_publication_outbox
  TO letletme_graphql_reader;
GRANT SELECT, USAGE
  ON SEQUENCE competition.my_fpl_snapshot_revision_seq TO letletme_data_writer;

COMMENT ON TABLE competition.my_fpl_snapshot_publications IS
  'Atomic My FPL product publications. Only the active row is queryable by GraphQL.';
COMMENT ON COLUMN competition.my_fpl_snapshot_publications.snapshot_date IS
  'UTC+8 calendar date of the daily publication obligation.';
COMMENT ON COLUMN competition.my_fpl_snapshot_publications.active IS
  'The sole product-visible revision for this season/gameweek.';
