-- Keep a durable, payload-level metadata baseline for obligations that have
-- not published a head yet. This distinguishes a real tournament correction
-- from a timestamp-only write without extending the repair horizon forever.

ALTER TABLE competition.tournament_review_obligations
  ADD COLUMN metadata_payload jsonb;

ALTER TABLE competition.tournament_review_obligations
  ADD CONSTRAINT tournament_review_obligations_metadata_payload_check
  CHECK (
    metadata_payload IS NULL
    OR jsonb_typeof(metadata_payload) = 'object'
  );

COMMENT ON COLUMN competition.tournament_review_obligations.metadata_payload IS
  'Last canonical tournament metadata payload observed by reconciliation; nullable for legacy rows until first observation.';
