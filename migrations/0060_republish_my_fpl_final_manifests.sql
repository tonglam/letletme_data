-- Rebuild and requeue active FINAL Redis manifests after the provenance
-- backfill. The publication row is durable, but a delivered outbox row may
-- still contain the pre-provenance manifest and would otherwise never be
-- dispatched again. Delivery state is mutable by design; the immutable child
-- rows and publication revision remain unchanged.
UPDATE competition.my_fpl_snapshot_publication_outbox AS outbox
SET manifest = jsonb_build_object(
      'dataset', 'fpl:my-fpl',
      'seasonCode', season.season_code,
      'eventId', publication.event_id,
      'revision', publication.revision,
      'snapshotDate', publication.snapshot_date,
      'sourceCheckedAt', publication.source_checked_at,
      'publishedAt', publication.published_at,
      'kind', publication.kind,
      'contentSha256', publication.content_sha256,
      'scoreSource', 'FPL_FINAL_RESULT',
      'livePublicationId', NULL,
      'liveRevision', NULL,
      'algorithmVersion', NULL,
      'sourceMinCheckedAt', publication.source_checked_at,
      'sourceMaxCheckedAt', publication.source_checked_at
    ),
    status = 'PENDING',
    available_at = now(),
    delivered_at = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error = NULL,
    updated_at = now()
FROM competition.my_fpl_snapshot_publications AS publication
JOIN fpl.seasons AS season
  ON season.season_id = publication.season_id
WHERE outbox.season_id = publication.season_id
  AND outbox.event_id = publication.event_id
  AND outbox.revision = publication.revision
  AND publication.kind = 'FINAL'
  AND publication.active;

-- A legacy active FINAL publication may predate the outbox row entirely.
-- Create the missing durable receipt so Redis can be brought to the same
-- revision by the normal dispatcher after the migration commits.
INSERT INTO competition.my_fpl_snapshot_publication_outbox (
  outbox_id, season_id, event_id, revision, manifest, status, available_at,
  created_at, updated_at
)
SELECT gen_random_uuid(),
       publication.season_id,
       publication.event_id,
       publication.revision,
       jsonb_build_object(
         'dataset', 'fpl:my-fpl',
         'seasonCode', season.season_code,
         'eventId', publication.event_id,
         'revision', publication.revision,
         'snapshotDate', publication.snapshot_date,
         'sourceCheckedAt', publication.source_checked_at,
         'publishedAt', publication.published_at,
         'kind', publication.kind,
         'contentSha256', publication.content_sha256,
         'scoreSource', 'FPL_FINAL_RESULT',
         'livePublicationId', NULL,
         'liveRevision', NULL,
         'algorithmVersion', NULL,
         'sourceMinCheckedAt', publication.source_checked_at,
         'sourceMaxCheckedAt', publication.source_checked_at
       ),
       'PENDING',
       now(),
       now(),
       now()
FROM competition.my_fpl_snapshot_publications AS publication
JOIN fpl.seasons AS season
  ON season.season_id = publication.season_id
LEFT JOIN competition.my_fpl_snapshot_publication_outbox AS outbox
  ON outbox.season_id = publication.season_id
 AND outbox.event_id = publication.event_id
 AND outbox.revision = publication.revision
WHERE publication.kind = 'FINAL'
  AND publication.active
  AND outbox.outbox_id IS NULL;
