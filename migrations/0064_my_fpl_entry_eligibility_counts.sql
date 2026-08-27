-- Keep late entrants visible in the immutable payload while excluding them
-- from the gameweek denominator.  Existing rows can derive the count from
-- their captured EMPTY children; future captures calculate it from the same
-- started_event eligibility helper used by the scheduler and audits.
ALTER TABLE competition.my_fpl_snapshot_publications
  ADD COLUMN IF NOT EXISTS not_applicable_entry_count integer NOT NULL DEFAULT 0;

WITH captured_counts AS (
  SELECT publication.season_id,
         publication.event_id,
         publication.revision,
         count(snapshot_entry.entry_id) FILTER (WHERE NOT snapshot_entry.is_empty)::integer
           AS eligible_entry_count,
         count(snapshot_entry.entry_id) FILTER (WHERE NOT snapshot_entry.is_empty)::integer
           AS ready_entry_count,
         count(snapshot_entry.entry_id) FILTER (WHERE snapshot_entry.is_empty)::integer
           AS not_applicable_entry_count
  FROM competition.my_fpl_snapshot_publications AS publication
  LEFT JOIN competition.my_fpl_snapshot_entries AS snapshot_entry
    ON snapshot_entry.season_id = publication.season_id
   AND snapshot_entry.event_id = publication.event_id
   AND snapshot_entry.revision = publication.revision
  GROUP BY publication.season_id, publication.event_id, publication.revision
  HAVING count(snapshot_entry.entry_id) > 0
)
UPDATE competition.my_fpl_snapshot_publications AS publication
SET expected_entry_count = captured_counts.eligible_entry_count,
    ready_entry_count = captured_counts.ready_entry_count,
    empty_entry_count = captured_counts.eligible_entry_count - captured_counts.ready_entry_count,
    not_applicable_entry_count = captured_counts.not_applicable_entry_count
FROM captured_counts
WHERE publication.season_id = captured_counts.season_id
  AND publication.event_id = captured_counts.event_id
  AND publication.revision = captured_counts.revision;

ALTER TABLE competition.my_fpl_snapshot_publications
  DROP CONSTRAINT IF EXISTS my_fpl_snapshot_publications_eligibility_counts_check;

ALTER TABLE competition.my_fpl_snapshot_publications
  ADD CONSTRAINT my_fpl_snapshot_publications_eligibility_counts_check
  CHECK (not_applicable_entry_count >= 0);

COMMENT ON COLUMN competition.my_fpl_snapshot_publications.not_applicable_entry_count IS
  'Entries added after this event. They remain as EMPTY payload rows but are excluded from the eligible denominator.';
