-- Separate X identity verification from handle-based acquisition.
--
-- Only OfficialFPL, the Premier League account and club-official accounts
-- require x_user_search.  Reporters/creators/publications/shows remain
-- recurring handle-only sources.  Semantic discoveries stay observed-only and
-- never become identity jobs or recurring schedules.

ALTER TABLE content.source_endpoints
  ADD COLUMN identity_requirement text NOT NULL DEFAULT 'NOT_APPLICABLE';

UPDATE content.source_endpoints AS endpoint
SET identity_requirement = CASE
      WHEN endpoint.adapter_kind <> 'X_ACCOUNT' THEN 'NOT_APPLICABLE'
      WHEN endpoint.origin = 'DISCOVERED'
        OR source.source_type = 'DISCOVERED_UNKNOWN' THEN 'DISCOVERED_ONLY'
      WHEN source.source_type IN ('OFFICIAL_FPL', 'LEAGUE_OFFICIAL', 'CLUB_OFFICIAL')
        THEN 'REQUIRED'
      ELSE 'HANDLE_ONLY'
    END
FROM content.sources AS source
WHERE source.source_id = endpoint.source_id;

-- These IDs were collected by the old all-X identity sweep.  They are not
-- authoritative for handle-only or observed endpoints, so clear them without
-- touching immutable ReceiptRevision or acquisition-run history.
UPDATE content.source_endpoints
SET
  stable_external_id = NULL,
  identity_status = 'PENDING',
  identity_error_summary = NULL,
  identity_checked_at = NULL,
  identity_next_check_at = NULL,
  updated_at = now()
WHERE adapter_kind = 'X_ACCOUNT'
  AND identity_requirement <> 'REQUIRED';

-- The compatibility source columns are not the authority for a handle-only
-- endpoint either.  Remove old X numeric IDs so a later official identity
-- check cannot report a false cross-source conflict; keep the human handle.
UPDATE content.sources AS source
SET
  platform = NULL,
  external_id = NULL,
  updated_at = now()
WHERE EXISTS (
    SELECT 1
    FROM content.source_endpoints AS endpoint
    WHERE endpoint.source_id = source.source_id
      AND endpoint.adapter_kind = 'X_ACCOUNT'
      AND endpoint.identity_requirement <> 'REQUIRED'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM content.source_endpoints AS required_endpoint
    WHERE required_endpoint.source_id = source.source_id
      AND required_endpoint.adapter_kind = 'X_ACCOUNT'
      AND required_endpoint.identity_requirement = 'REQUIRED'
  );

ALTER TABLE content.source_endpoints
  ADD CONSTRAINT content_source_endpoints_identity_requirement_check
    CHECK (
      identity_requirement IN (
        'REQUIRED',
        'HANDLE_ONLY',
        'DISCOVERED_ONLY',
        'NOT_APPLICABLE'
      )
    );

DROP INDEX IF EXISTS content.content_source_endpoints_identity_due_idx;
CREATE INDEX content_source_endpoints_identity_due_idx
  ON content.source_endpoints (identity_next_check_at, endpoint_id)
  WHERE status = 'active'
    AND adapter_kind = 'X_ACCOUNT'
    AND identity_requirement = 'REQUIRED'
    AND identity_status IN ('PENDING', 'FAILED', 'VERIFIED');

GRANT SELECT, INSERT, UPDATE ON content.source_endpoints TO letletme_data_writer;

COMMENT ON COLUMN content.source_endpoints.identity_requirement IS
  'X identity policy: REQUIRED official account, HANDLE_ONLY manifest handle, DISCOVERED_ONLY semantic observation, or NOT_APPLICABLE';
