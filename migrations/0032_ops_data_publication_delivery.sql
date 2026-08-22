-- Durable delivery for Data publications.
-- PostgreSQL is canonical: Redis is only a rebuildable projection.  The row is
-- inserted in the same transaction that activates a publication so a process
-- crash cannot leave a DB publication with no delivery work.
CREATE TABLE ops.data_publication_outbox (
  outbox_id uuid PRIMARY KEY,
  publication_id uuid NOT NULL REFERENCES ops.dataset_publications(publication_id) ON DELETE CASCADE,
  source_run_id uuid REFERENCES ops.sync_runs(run_id) ON DELETE RESTRICT,
  dataset text NOT NULL,
  season_id smallint,
  event_id integer,
  manifest jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  staged_at timestamptz,
  db_activated_at timestamptz,
  redis_activated_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT data_publication_outbox_dataset_check
    CHECK (dataset IN ('fpl:core', 'fpl:live', 'fpl:market')),
  CONSTRAINT data_publication_outbox_status_check
    CHECK (status IN ('pending', 'staged', 'db_activated', 'redis_activated', 'delivered', 'failed')),
  CONSTRAINT data_publication_outbox_attempts_check CHECK (attempts >= 0),
  CONSTRAINT data_publication_outbox_lease_check CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT data_publication_outbox_manifest_object_check
    CHECK (jsonb_typeof(manifest) = 'object'),
  CONSTRAINT data_publication_outbox_event_check CHECK (event_id IS NULL OR event_id > 0),
  CONSTRAINT data_publication_outbox_season_fk
    FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id)
);

CREATE UNIQUE INDEX data_publication_outbox_publication_key
  ON ops.data_publication_outbox (publication_id);
CREATE INDEX data_publication_outbox_pending_idx
  ON ops.data_publication_outbox (available_at, outbox_id)
  WHERE status IN ('pending', 'staged', 'db_activated', 'redis_activated')
    AND delivered_at IS NULL;
CREATE INDEX data_publication_outbox_reclaim_idx
  ON ops.data_publication_outbox (lease_expires_at, outbox_id)
  WHERE delivered_at IS NULL AND lease_expires_at IS NOT NULL;

ALTER TABLE ops.dataset_publication_items
  DROP CONSTRAINT dataset_publication_items_name_valid,
  ADD CONSTRAINT dataset_publication_items_name_valid CHECK (
    item_name IN (
      'context',
      'events', 'teams', 'players', 'phases', 'fixtures',
      'currentEventId', 'selectionRules',
      'eventLive'
    )
  );

ALTER TABLE ops.dataset_publication_items
  DROP CONSTRAINT dataset_publication_items_payload_shape,
  ADD CONSTRAINT dataset_publication_items_payload_shape CHECK (
    jsonb_typeof(payload) = ANY (
      ARRAY['array'::text, 'object'::text, 'number'::text, 'null'::text, 'boolean'::text, 'string'::text]
    )
  );

REVOKE ALL ON TABLE ops.data_publication_outbox FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE ops.data_publication_outbox TO letletme_data_writer;
REVOKE ALL ON TABLE ops.data_publication_outbox FROM letletme_graphql_reader;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ops.dataset_publication_items TO letletme_data_writer;
GRANT SELECT ON TABLE ops.dataset_publication_items TO letletme_graphql_reader;
