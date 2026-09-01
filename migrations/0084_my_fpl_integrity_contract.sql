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
                         AND (entry.started_event IS NULL OR entry.started_event <= publication.event_id)
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
  LEFT JOIN competition.entries entry
    ON entry.season_id = snapshot_entry.season_id
   AND entry.entry_id = snapshot_entry.entry_id
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
         ) AS expected_entry_scope_sha256
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
