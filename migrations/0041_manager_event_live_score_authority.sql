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

-- League projections combine two independently refreshed official inputs.
-- Keep both observations separate from source_checked_at, which remains the
-- database-clock convergence token used by finalized checkpoints.
ALTER TABLE competition.league_event_results
  ADD COLUMN source_live_checked_at timestamptz,
  ADD COLUMN source_picks_checked_at timestamptz;

ALTER TABLE competition.league_event_results
  ADD CONSTRAINT league_event_results_source_pair_valid
  CHECK (
    (source_live_checked_at IS NULL AND source_picks_checked_at IS NULL)
    OR
    (source_live_checked_at IS NOT NULL AND source_picks_checked_at IS NOT NULL)
  );
