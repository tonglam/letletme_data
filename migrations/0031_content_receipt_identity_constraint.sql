-- Receipt identity is now scoped by receipt_key, which includes content kind.
-- The legacy source/external-id uniqueness rejects valid cross-kind collisions.
ALTER TABLE content.source_receipts
  DROP CONSTRAINT content_source_receipts_source_external_key;
