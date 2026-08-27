-- A tournament deletion removes any My FPL publication that contains the
-- tournament.  Redis is a rebuildable read model, so the deletion must first
-- leave a durable receipt before the database transaction can commit.  This
-- table deliberately does not reference a publication or tournament: both
-- rows are deleted by the same transaction and the receipt must survive it.
CREATE TABLE competition.my_fpl_snapshot_invalidation_outbox (
  outbox_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  revision bigint NOT NULL,
  tournament_id integer NOT NULL,
  reason text NOT NULL DEFAULT 'TOURNAMENT_DELETED',
  status text NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT my_fpl_snapshot_invalidation_outbox_season_fk
    FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id),
  CONSTRAINT my_fpl_snapshot_invalidation_outbox_event_fk
    FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id),
  CONSTRAINT my_fpl_snapshot_invalidation_outbox_tournament_id_check
    CHECK (tournament_id > 0),
  CONSTRAINT my_fpl_snapshot_invalidation_outbox_reason_check
    CHECK (reason = 'TOURNAMENT_DELETED'),
  CONSTRAINT my_fpl_snapshot_invalidation_outbox_status_check
    CHECK (status = ANY (ARRAY['PENDING'::text, 'PROCESSING'::text, 'DELIVERED'::text, 'SUPERSEDED'::text, 'FAILED'::text])),
  CONSTRAINT my_fpl_snapshot_invalidation_outbox_attempts_check
    CHECK (attempts >= 0),
  CONSTRAINT my_fpl_snapshot_invalidation_outbox_lease_check
    CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL)
      OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE UNIQUE INDEX my_fpl_snapshot_invalidation_outbox_revision_key
  ON competition.my_fpl_snapshot_invalidation_outbox(season_id, event_id, revision);

CREATE INDEX my_fpl_snapshot_invalidation_outbox_pending_idx
  ON competition.my_fpl_snapshot_invalidation_outbox(available_at, outbox_id)
  WHERE status IN ('PENDING', 'FAILED') AND delivered_at IS NULL;

CREATE INDEX my_fpl_snapshot_invalidation_outbox_reclaim_idx
  ON competition.my_fpl_snapshot_invalidation_outbox(lease_expires_at, outbox_id)
  WHERE status = 'PROCESSING' AND delivered_at IS NULL;

CREATE INDEX my_fpl_snapshot_invalidation_outbox_tournament_idx
  ON competition.my_fpl_snapshot_invalidation_outbox(season_id, tournament_id, status, outbox_id);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE competition.my_fpl_snapshot_invalidation_outbox
  TO letletme_data_writer;

ALTER TABLE competition.my_fpl_snapshot_invalidation_outbox ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'letletme_data_writer') THEN
    CREATE POLICY my_fpl_snapshot_invalidation_outbox_writer_all
      ON competition.my_fpl_snapshot_invalidation_outbox
      FOR ALL TO letletme_data_writer USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMENT ON TABLE competition.my_fpl_snapshot_invalidation_outbox IS
  'Durable Redis invalidation receipts for My FPL revisions removed by tournament deletion.';
COMMENT ON COLUMN competition.my_fpl_snapshot_invalidation_outbox.revision IS
  'The deleted My FPL revision. No publication foreign key is intentional: the publication is deleted in the same transaction.';
COMMENT ON COLUMN competition.my_fpl_snapshot_invalidation_outbox.reason IS
  'Fixed invalidation reason; currently only TOURNAMENT_DELETED is supported.';
COMMENT ON COLUMN competition.my_fpl_snapshot_invalidation_outbox.lease_expires_at IS
  'Claim lease expires after two minutes and can be reclaimed by maintenance.';
COMMENT ON COLUMN competition.my_fpl_snapshot_invalidation_outbox.available_at IS
  'Next retry time; ordinary Redis failures are delayed by five minutes.';
