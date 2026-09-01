-- My FPL integrity contract: persist the exact entry/tournament scope that a
-- publication was captured against and expose one Data-owned status view to
-- read-only consumers. Existing rows are backfilled from their immutable
-- child rows so the hard cut can compare the old revision with today's
-- canonical scope instead of treating a changed denominator as complete.
ALTER TABLE competition.my_fpl_snapshot_publications
  ADD COLUMN IF NOT EXISTS entry_scope_sha256 text,
  ADD COLUMN IF NOT EXISTS tournament_scope_sha256 text;

-- Scope hashes use the same SHA-256(JSON.stringify(ordered IDs)) contract as
-- the worker. Keep crypto functions in the controlled extensions namespace,
-- matching the existing pg_trgm extension policy.
CREATE SCHEMA IF NOT EXISTS extensions;

DO $$
DECLARE
  installed_schema text;
BEGIN
  SELECT namespace.nspname
    INTO installed_schema
  FROM pg_extension extension_row
  JOIN pg_namespace namespace ON namespace.oid = extension_row.extnamespace
  WHERE extension_row.extname = 'pgcrypto';

  IF installed_schema IS NULL THEN
    EXECUTE 'CREATE EXTENSION pgcrypto WITH SCHEMA extensions';
  ELSIF installed_schema <> 'extensions' THEN
    EXECUTE 'ALTER EXTENSION pgcrypto SET SCHEMA extensions';
  END IF;
END $$;

WITH entry_hashes AS (
  SELECT publication.season_id,
         publication.event_id,
         publication.revision,
         encode(
           extensions.digest(
             convert_to(
               COALESCE(
                 to_json(
                   array_agg(snapshot_entry.entry_id::text ORDER BY snapshot_entry.entry_id)
                     FILTER (
                       WHERE snapshot_entry.entry_id IS NOT NULL
                         AND NOT snapshot_entry.is_empty
                     )
                 )::text,
                 '[]'
               ),
               'UTF8'
             ),
             'sha256'
           ),
           'hex'
         ) AS entry_scope_sha256
  FROM competition.my_fpl_snapshot_publications publication
  LEFT JOIN competition.my_fpl_snapshot_entries snapshot_entry
    ON snapshot_entry.season_id = publication.season_id
   AND snapshot_entry.event_id = publication.event_id
   AND snapshot_entry.revision = publication.revision
  WHERE publication.entry_scope_sha256 IS NULL
  GROUP BY publication.season_id, publication.event_id, publication.revision
), tournament_hashes AS (
  SELECT publication.season_id,
         publication.event_id,
         publication.revision,
         encode(
           extensions.digest(
             convert_to(
               COALESCE(
                 to_json(
                   array_agg(
                     format('%s:%s', snapshot_row.tournament_id, snapshot_row.entry_id)
                     ORDER BY snapshot_row.tournament_id, snapshot_row.entry_id
                   ) FILTER (WHERE snapshot_row.tournament_id IS NOT NULL)
                 )::text,
                 '[]'
               ),
               'UTF8'
             ),
             'sha256'
           ),
           'hex'
         ) AS tournament_scope_sha256
  FROM competition.my_fpl_snapshot_publications publication
  LEFT JOIN competition.my_fpl_snapshot_tournament_rows snapshot_row
    ON snapshot_row.season_id = publication.season_id
   AND snapshot_row.event_id = publication.event_id
   AND snapshot_row.revision = publication.revision
  WHERE publication.tournament_scope_sha256 IS NULL
  GROUP BY publication.season_id, publication.event_id, publication.revision
)
UPDATE competition.my_fpl_snapshot_publications publication
SET entry_scope_sha256 = entry_hashes.entry_scope_sha256,
    tournament_scope_sha256 = tournament_hashes.tournament_scope_sha256,
    updated_at = clock_timestamp()
FROM entry_hashes, tournament_hashes
WHERE publication.season_id = entry_hashes.season_id
  AND publication.event_id = entry_hashes.event_id
  AND publication.revision = entry_hashes.revision
  AND publication.season_id = tournament_hashes.season_id
  AND publication.event_id = tournament_hashes.event_id
  AND publication.revision = tournament_hashes.revision;

-- Rebuild the durable receipt for every active revision after the scope hard
-- cut. A publication created before this migration can still have a delivered
-- outbox row (and Redis pointer) whose manifest predates the count/hash
-- contract. Requeue that exact revision through the normal dispatcher so the
-- last accepted snapshot stays available without a source capture or direct
-- Redis write.
UPDATE competition.my_fpl_snapshot_publication_outbox AS outbox
SET manifest = jsonb_build_object(
      'dataset', 'fpl:my-fpl',
      'seasonCode', season.season_code,
      'eventId', publication.event_id,
      'revision', publication.revision,
      'snapshotDate', publication.snapshot_date,
      'sourceCheckedAt', to_char(publication.source_checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'publishedAt', to_char(publication.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'kind', publication.kind,
      'contentSha256', publication.content_sha256,
      'expectedEntryCount', publication.expected_entry_count,
      'observedEntryCount', publication.ready_entry_count + publication.empty_entry_count,
      'expectedTournamentCount', publication.expected_tournament_count,
      'observedTournamentCount', publication.ready_tournament_count,
      'entryScopeSha256', publication.entry_scope_sha256,
      'tournamentScopeSha256', publication.tournament_scope_sha256,
      'scoreSource', COALESCE(publication.score_source, outbox.manifest->>'scoreSource'),
      'livePublicationId', COALESCE(publication.live_publication_id::text, outbox.manifest->>'livePublicationId'),
      'liveRevision', COALESCE(publication.live_revision, outbox.manifest->>'liveRevision'),
      'algorithmVersion', COALESCE(publication.algorithm_version, outbox.manifest->>'algorithmVersion'),
      'sourceMinCheckedAt', to_char(publication.source_checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'sourceMaxCheckedAt', to_char(COALESCE(publication.source_max_checked_at, publication.source_checked_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    status = 'PENDING',
    available_at = clock_timestamp(),
    delivered_at = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error = NULL,
    updated_at = clock_timestamp()
FROM competition.my_fpl_snapshot_publications AS publication
JOIN fpl.seasons AS season
  ON season.season_id = publication.season_id
WHERE outbox.season_id = publication.season_id
  AND outbox.event_id = publication.event_id
  AND outbox.revision = publication.revision
  AND publication.active
  AND publication.entry_scope_sha256 IS NOT NULL
  AND publication.tournament_scope_sha256 IS NOT NULL
  AND (
    publication.kind = 'FINAL'
    OR (
      COALESCE(publication.score_source, outbox.manifest->>'scoreSource') = 'FPL_EVENT_LIVE'
      AND COALESCE(publication.live_publication_id::text, outbox.manifest->>'livePublicationId') ~
        '^[0-9a-fA-F-]{36}$'
      AND COALESCE(publication.live_revision, outbox.manifest->>'liveRevision') IS NOT NULL
      AND COALESCE(publication.algorithm_version, outbox.manifest->>'algorithmVersion') =
        'live-points-v2-algorithm-1'
    )
  );

-- A legacy active publication may predate the outbox receipt entirely. Add a
-- receipt only when its complete manifest can be reconstructed from durable
-- publication fields; the dispatcher remains the sole Redis writer.
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
         'sourceCheckedAt', to_char(publication.source_checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'publishedAt', to_char(publication.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'kind', publication.kind,
         'contentSha256', publication.content_sha256,
         'expectedEntryCount', publication.expected_entry_count,
         'observedEntryCount', publication.ready_entry_count + publication.empty_entry_count,
         'expectedTournamentCount', publication.expected_tournament_count,
         'observedTournamentCount', publication.ready_tournament_count,
         'entryScopeSha256', publication.entry_scope_sha256,
         'tournamentScopeSha256', publication.tournament_scope_sha256,
         'scoreSource', publication.score_source,
         'livePublicationId', publication.live_publication_id,
         'liveRevision', publication.live_revision,
         'algorithmVersion', publication.algorithm_version,
         'sourceMinCheckedAt', to_char(publication.source_checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'sourceMaxCheckedAt', to_char(COALESCE(publication.source_max_checked_at, publication.source_checked_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       ),
       'PENDING',
       clock_timestamp(),
       clock_timestamp(),
       clock_timestamp()
FROM competition.my_fpl_snapshot_publications AS publication
JOIN fpl.seasons AS season
  ON season.season_id = publication.season_id
LEFT JOIN competition.my_fpl_snapshot_publication_outbox AS outbox
  ON outbox.season_id = publication.season_id
 AND outbox.event_id = publication.event_id
 AND outbox.revision = publication.revision
WHERE publication.active
  AND outbox.outbox_id IS NULL
  AND publication.entry_scope_sha256 IS NOT NULL
  AND publication.tournament_scope_sha256 IS NOT NULL
  AND (
    publication.kind = 'FINAL'
    OR (
      publication.score_source = 'FPL_EVENT_LIVE'
      AND publication.live_publication_id IS NOT NULL
      AND publication.live_revision IS NOT NULL
      AND publication.algorithm_version = 'live-points-v2-algorithm-1'
    )
  );

ALTER TABLE competition.my_fpl_snapshot_publications
  DROP CONSTRAINT IF EXISTS my_fpl_snapshot_publications_entry_scope_hash_check,
  DROP CONSTRAINT IF EXISTS my_fpl_snapshot_publications_tournament_scope_hash_check;

ALTER TABLE competition.my_fpl_snapshot_publications
  ADD CONSTRAINT my_fpl_snapshot_publications_entry_scope_hash_check
    CHECK (entry_scope_sha256 IS NULL OR entry_scope_sha256 ~ '^[0-9a-f]{64}$'::text),
  ADD CONSTRAINT my_fpl_snapshot_publications_tournament_scope_hash_check
    CHECK (tournament_scope_sha256 IS NULL OR tournament_scope_sha256 ~ '^[0-9a-f]{64}$'::text);

COMMENT ON COLUMN competition.my_fpl_snapshot_publications.entry_scope_sha256 IS
  'SHA-256 digest of JSON.stringify(ordered eligible entry IDs) captured by this revision.';
COMMENT ON COLUMN competition.my_fpl_snapshot_publications.tournament_scope_sha256 IS
  'SHA-256 digest of JSON.stringify(ordered tournament:entry memberships) captured by this revision.';

CREATE OR REPLACE VIEW reporting.my_fpl_active_snapshot_status
WITH (security_invoker = true) AS
WITH active AS (
  SELECT publication.season_id,
         publication.event_id,
         publication.revision,
         publication.snapshot_date,
         publication.kind,
         publication.source_checked_at,
         publication.published_at,
         publication.expected_entry_count,
         publication.ready_entry_count,
         publication.empty_entry_count,
         publication.not_applicable_entry_count,
         publication.expected_tournament_count,
         publication.ready_tournament_count,
         publication.entry_scope_sha256,
         publication.tournament_scope_sha256
  FROM competition.my_fpl_snapshot_publications publication
  WHERE publication.active
), canonical_entry_scopes AS (
  SELECT event.season_id,
         event.event_id,
         encode(
           extensions.digest(
             convert_to(
               COALESCE(
                     to_json(
                   array_agg(entry.entry_id::text ORDER BY entry.entry_id)
                     FILTER (WHERE entry.entry_id IS NOT NULL)
                 )::text,
                 '[]'
               ),
               'UTF8'
             ),
             'sha256'
           ),
           'hex'
         ) AS expected_entry_scope_sha256,
         count(DISTINCT entry.entry_id) FILTER (
           WHERE entry.entry_id IS NOT NULL
             AND entry.started_event IS NOT NULL
             AND entry.started_event > event.event_id
         )::integer AS expected_not_applicable_entry_count
  FROM fpl.events event
  LEFT JOIN competition.entries entry
    ON entry.season_id = event.season_id
   AND (entry.started_event IS NULL OR entry.started_event <= event.event_id)
  GROUP BY event.season_id, event.event_id
), canonical_tournament_scopes AS (
  SELECT event.season_id,
         event.event_id,
         encode(
           extensions.digest(
             convert_to(
               COALESCE(
                 to_json(
                   array_agg(
                     format('%s:%s', roster.tournament_id, roster.entry_id)
                     ORDER BY roster.tournament_id, roster.entry_id
                   ) FILTER (WHERE roster.tournament_id IS NOT NULL)
                 )::text,
                 '[]'
               ),
               'UTF8'
             ),
             'sha256'
           ),
           'hex'
         ) AS expected_tournament_scope_sha256
  FROM fpl.events event
  LEFT JOIN competition.tournament_entries roster
    ON roster.season_id = event.season_id
  GROUP BY event.season_id, event.event_id
), canonical_scopes AS (
  SELECT entry_scope.season_id,
         entry_scope.event_id,
         entry_scope.expected_entry_scope_sha256,
         entry_scope.expected_not_applicable_entry_count,
         tournament_scope.expected_tournament_scope_sha256
  FROM canonical_entry_scopes entry_scope
  JOIN canonical_tournament_scopes tournament_scope
    ON tournament_scope.season_id = entry_scope.season_id
   AND tournament_scope.event_id = entry_scope.event_id
), eligible AS (
  SELECT event.season_id,
         event.event_id,
         count(DISTINCT entry.entry_id)::integer AS expected_entry_count,
         count(DISTINCT snapshot_entry.entry_id) FILTER (WHERE snapshot_entry.entry_id IS NOT NULL)::integer
           AS observed_entry_count
  FROM fpl.events event
  LEFT JOIN competition.entries entry
    ON entry.season_id = event.season_id
   AND (entry.started_event IS NULL OR entry.started_event <= event.event_id)
  LEFT JOIN active
    ON active.season_id = event.season_id
   AND active.event_id = event.event_id
  LEFT JOIN competition.my_fpl_snapshot_entries snapshot_entry
    ON snapshot_entry.season_id = entry.season_id
   AND snapshot_entry.entry_id = entry.entry_id
   AND snapshot_entry.event_id = event.event_id
   AND snapshot_entry.revision = active.revision
  GROUP BY event.season_id, event.event_id
), tournaments AS (
  SELECT event.season_id,
         event.event_id,
         count(DISTINCT tournament.tournament_id)::integer AS expected_tournament_count,
         count(DISTINCT snapshot_aggregate.tournament_id) FILTER (WHERE snapshot_aggregate.tournament_id IS NOT NULL)::integer
           AS observed_tournament_count
  FROM fpl.events event
  LEFT JOIN competition.tournaments tournament
    ON tournament.season_id = event.season_id
  LEFT JOIN active
    ON active.season_id = event.season_id
   AND active.event_id = event.event_id
  LEFT JOIN competition.my_fpl_snapshot_tournament_aggregates snapshot_aggregate
    ON snapshot_aggregate.season_id = event.season_id
   AND snapshot_aggregate.event_id = event.event_id
   AND snapshot_aggregate.revision = active.revision
   AND snapshot_aggregate.tournament_id = tournament.tournament_id
  GROUP BY event.season_id, event.event_id
)
SELECT event.season_id,
       event.event_id,
       active.revision,
       active.snapshot_date,
       active.kind,
       event.finished,
       event.data_checked,
       event.data_checked_at,
       active.source_checked_at,
       active.published_at,
       CASE WHEN event.data_checked_at IS NULL THEN NULL ELSE event.data_checked_at END
         AS finalization_started_at,
       CASE WHEN event.data_checked_at IS NULL THEN NULL
            ELSE event.data_checked_at + interval '4500 seconds' END
         AS finalization_due_at,
       COALESCE(eligible.expected_entry_count, 0)::integer AS expected_entry_count,
       COALESCE(eligible.observed_entry_count, 0)::integer AS observed_entry_count,
       COALESCE(active.not_applicable_entry_count, 0)::integer AS not_applicable_entry_count,
       COALESCE(canonical_scopes.expected_not_applicable_entry_count, 0)::integer
         AS expected_not_applicable_entry_count,
       GREATEST(
         COALESCE(eligible.expected_entry_count, 0) - COALESCE(eligible.observed_entry_count, 0),
         0
       )::integer AS pending_correction_entry_count,
       COALESCE(tournaments.expected_tournament_count, 0)::integer AS expected_tournament_count,
       COALESCE(tournaments.observed_tournament_count, 0)::integer AS observed_tournament_count,
       CASE WHEN active.kind IS NULL THEN 'NO_PUBLICATION'
            WHEN GREATEST(COALESCE(eligible.expected_entry_count, 0) - COALESCE(eligible.observed_entry_count, 0), 0) > 0
              OR COALESCE(tournaments.expected_tournament_count, 0)
                   <> COALESCE(tournaments.observed_tournament_count, 0)
              OR active.entry_scope_sha256 IS DISTINCT FROM canonical_scopes.expected_entry_scope_sha256
              OR active.tournament_scope_sha256 IS DISTINCT FROM canonical_scopes.expected_tournament_scope_sha256
              OR COALESCE(active.not_applicable_entry_count, 0) IS DISTINCT FROM
                 COALESCE(canonical_scopes.expected_not_applicable_entry_count, 0)
              THEN 'CORRECTION_PENDING'
            ELSE 'COMPLETE' END AS coverage_state,
       canonical_scopes.expected_entry_scope_sha256,
       canonical_scopes.expected_tournament_scope_sha256,
       active.entry_scope_sha256 AS observed_entry_scope_sha256,
       active.tournament_scope_sha256 AS observed_tournament_scope_sha256
FROM fpl.events event
LEFT JOIN active
  ON active.season_id = event.season_id
 AND active.event_id = event.event_id
LEFT JOIN eligible
  ON eligible.season_id = event.season_id
 AND eligible.event_id = event.event_id
LEFT JOIN tournaments
  ON tournaments.season_id = event.season_id
 AND tournaments.event_id = event.event_id
LEFT JOIN canonical_scopes
  ON canonical_scopes.season_id = event.season_id
 AND canonical_scopes.event_id = event.event_id;

GRANT SELECT ON reporting.my_fpl_active_snapshot_status TO letletme_graphql_reader;
GRANT SELECT ON reporting.my_fpl_active_snapshot_status TO letletme_data_writer;
GRANT USAGE ON SCHEMA extensions TO letletme_graphql_reader, letletme_data_writer;
GRANT EXECUTE ON FUNCTION extensions.digest(bytea, text)
  TO letletme_graphql_reader, letletme_data_writer;

-- The status is a Data-owned read boundary; GraphQL must not read scheduler or
-- governance implementation tables to reconstruct it.
COMMENT ON VIEW reporting.my_fpl_active_snapshot_status IS
  'Data-owned active My FPL revision, scope coverage and finalization deadline status.';
