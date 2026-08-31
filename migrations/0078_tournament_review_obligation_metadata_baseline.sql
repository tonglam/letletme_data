-- Keep a durable, payload-level metadata baseline for obligations that have
-- not published a head yet. This distinguishes a real tournament correction
-- from a timestamp-only write without extending the repair horizon forever.

ALTER TABLE competition.tournament_review_obligations
  ADD COLUMN metadata_payload jsonb;

-- Existing published scopes already have an authoritative tournament header.
-- Seed those baselines before the new reconciliation logic runs; only
-- headless legacy obligations remain NULL and are initialized without a
-- retry so the first observation cannot create timestamp churn.
UPDATE competition.tournament_review_obligations obligation
SET metadata_payload = publication.payload #> '{tournament}'
FROM competition.tournament_review_heads head
JOIN competition.tournament_review_publications publication
  ON publication.season_id = head.season_id
 AND publication.tournament_id = head.tournament_id
 AND publication.event_id = head.event_id
 AND publication.revision = head.revision
WHERE obligation.season_id = head.season_id
  AND obligation.tournament_id = head.tournament_id
  AND obligation.event_id = head.event_id
  AND obligation.metadata_payload IS NULL
  AND jsonb_typeof(publication.payload #> '{tournament}') = 'object';

ALTER TABLE competition.tournament_review_obligations
  ADD CONSTRAINT tournament_review_obligations_metadata_payload_check
  CHECK (
    metadata_payload IS NULL
    OR jsonb_typeof(metadata_payload) = 'object'
  );

COMMENT ON COLUMN competition.tournament_review_obligations.metadata_payload IS
  'Last canonical tournament metadata payload observed by reconciliation; nullable for legacy rows until first observation.';
