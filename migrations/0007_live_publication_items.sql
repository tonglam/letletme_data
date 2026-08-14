-- Live publication staging and persistence markers.
--
-- Redis remains the low-latency publication pointer.  These rows are the
-- PostgreSQL proof that every immutable item belonging to the same revision
-- was staged before activation; they are never assembled from mutable facts.

ALTER TABLE fpl.events
  ADD COLUMN live_facts_persisted_at timestamptz;

CREATE TABLE ops.dataset_publication_items (
  publication_id uuid NOT NULL,
  item_name text NOT NULL,
  payload jsonb NOT NULL,
  item_count integer NOT NULL,
  checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dataset_publication_items_publication_id_item_name_pk
    PRIMARY KEY (publication_id, item_name),
  CONSTRAINT dataset_publication_items_publication_fk
    FOREIGN KEY (publication_id)
    REFERENCES ops.dataset_publications(publication_id) ON DELETE CASCADE,
  CONSTRAINT dataset_publication_items_name_valid
    CHECK (item_name IN ('eventLive', 'fixtures')),
  CONSTRAINT dataset_publication_items_count_nonnegative
    CHECK (item_count >= 0),
  CONSTRAINT dataset_publication_items_checksum_nonempty
    CHECK (btrim(checksum) <> ''),
  CONSTRAINT dataset_publication_items_payload_shape
    CHECK (jsonb_typeof(payload) = ANY (ARRAY['array'::text, 'object'::text]))
);

CREATE INDEX dataset_publication_items_publication_idx
  ON ops.dataset_publication_items (publication_id);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE ops.dataset_publication_items TO letletme_data_writer;
GRANT SELECT ON TABLE ops.dataset_publication_items TO letletme_graphql_reader;
