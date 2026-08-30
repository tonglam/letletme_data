-- V2 no longer publishes the retired fpl:live outbox dataset.  Keep the
-- migration ledger immutable and correct the constraint introduced by the V1
-- publication pipeline in a new forward-only migration.
ALTER TABLE ops.data_publication_outbox
  DROP CONSTRAINT data_publication_outbox_dataset_check,
  ADD CONSTRAINT data_publication_outbox_dataset_check CHECK (
    dataset IN ('fpl:core', 'fpl:market', 'fpl:price-changes')
  );
