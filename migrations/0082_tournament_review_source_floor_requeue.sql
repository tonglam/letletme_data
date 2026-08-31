-- Requeue existing review heads whose persisted source span predates the
-- finalized event checkpoint.  The source-floor correction changes the
-- publication identity, so leaving these heads READY would keep serving a
-- revision that the GraphQL consumer must (correctly) reject.
--
-- Retain immutable publication rows for audit/retention.  Only the mutable
-- head is retired; the obligation is reset so the normal worker publishes a
-- new revision under its existing lock, retry, lease, and 24-hour horizon.
WITH stale_scopes AS MATERIALIZED (
  SELECT head.season_id,
         head.tournament_id,
         head.event_id
  FROM competition.tournament_review_heads head
  JOIN competition.tournament_review_publications publication
    ON publication.season_id = head.season_id
   AND publication.tournament_id = head.tournament_id
   AND publication.event_id = head.event_id
   AND publication.revision = head.revision
  WHERE publication.source_min_checked_at < publication.event_data_checked_at
), retired_heads AS (
  DELETE FROM competition.tournament_review_heads head
  USING stale_scopes stale
  WHERE head.season_id = stale.season_id
    AND head.tournament_id = stale.tournament_id
    AND head.event_id = stale.event_id
  RETURNING head.season_id, head.tournament_id, head.event_id
)
UPDATE competition.tournament_review_obligations obligation
SET state = 'PENDING',
    eligible_at = GREATEST(obligation.eligible_at, clock_timestamp()),
    next_attempt_at = clock_timestamp(),
    execution_attempts = 0,
    source_rechecks = 0,
    lease_owner = NULL,
    lease_expires_at = NULL,
    first_attempt_at = NULL,
    last_attempt_at = NULL,
    ready_at = NULL,
    degraded_at = NULL,
    ready_revision = NULL,
    last_error_code = NULL,
    last_failure_fingerprint = NULL,
    updated_at = clock_timestamp()
FROM retired_heads retired
WHERE obligation.season_id = retired.season_id
  AND obligation.tournament_id = retired.tournament_id
  AND obligation.event_id = retired.event_id;

