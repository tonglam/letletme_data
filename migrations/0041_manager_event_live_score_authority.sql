-- Active manager score checkpoints may identify the revisioned official
-- event-live player publication as their score authority. Entry Summary and
-- league feeds remain valid metadata/finalization sources but cannot own an
-- active score.

ALTER TABLE fpl.manager_event_score_snapshots
  DROP CONSTRAINT manager_event_score_snapshots_source_valid;

ALTER TABLE fpl.manager_event_score_snapshots
  ADD CONSTRAINT manager_event_score_snapshots_source_valid
  CHECK (
    source IN (
      'FPL_EVENT_LIVE',
      'FPL_ENTRY_SUMMARY',
      'FPL_CLASSIC_STANDINGS',
      'FPL_FINAL_RESULT'
    )
  );
