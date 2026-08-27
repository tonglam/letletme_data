-- Keep late entrants visible in the immutable payload while excluding them
-- from the gameweek denominator.  Existing rows can derive the count from
-- their captured EMPTY children; future captures calculate it from the same
-- started_event eligibility helper used by the scheduler and audits.
ALTER TABLE competition.my_fpl_snapshot_publications
  ADD COLUMN IF NOT EXISTS not_applicable_entry_count integer NOT NULL DEFAULT 0;

UPDATE competition.my_fpl_snapshot_publications AS publication
SET not_applicable_entry_count = COALESCE(
      (
        SELECT count(*)::integer
        FROM competition.my_fpl_snapshot_entries AS snapshot_entry
        WHERE snapshot_entry.season_id = publication.season_id
          AND snapshot_entry.event_id = publication.event_id
          AND snapshot_entry.revision = publication.revision
          AND snapshot_entry.is_empty
      ),
      0
    ),
    updated_at = clock_timestamp();

ALTER TABLE competition.my_fpl_snapshot_publications
  DROP CONSTRAINT IF EXISTS my_fpl_snapshot_publications_eligibility_counts_check;

ALTER TABLE competition.my_fpl_snapshot_publications
  ADD CONSTRAINT my_fpl_snapshot_publications_eligibility_counts_check
  CHECK (not_applicable_entry_count >= 0);

COMMENT ON COLUMN competition.my_fpl_snapshot_publications.not_applicable_entry_count IS
  'Entries added after this event. They remain as EMPTY payload rows but are excluded from the eligible denominator.';
