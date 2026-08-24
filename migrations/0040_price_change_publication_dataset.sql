-- Allow the scheduled official price-change board to use the canonical Data
-- publication/outbox pipeline.  The payload is stored in the existing
-- context/players publication items; Redis remains a rebuildable projection.
ALTER TABLE ops.data_publication_outbox
  DROP CONSTRAINT data_publication_outbox_dataset_check,
  ADD CONSTRAINT data_publication_outbox_dataset_check CHECK (
    dataset IN ('fpl:core', 'fpl:live', 'fpl:market', 'fpl:price-changes')
  );
