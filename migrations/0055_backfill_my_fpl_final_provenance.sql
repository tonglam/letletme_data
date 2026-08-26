-- Publications created before the score-provenance columns were introduced
-- are still unambiguous when kind=FINAL: their headline authority is the
-- finalized entry result path and source_checked_at is the only timestamp the
-- legacy row recorded. Backfill that exact provenance so an active FINAL
-- publication remains readable instead of becoming a terminal dead end.
UPDATE competition.my_fpl_snapshot_publications
SET score_source = 'FPL_FINAL_RESULT',
    live_publication_id = NULL,
    live_revision = NULL,
    algorithm_version = NULL,
    source_min_checked_at = source_checked_at,
    source_max_checked_at = source_checked_at,
    updated_at = now()
WHERE kind = 'FINAL'
  AND (
    score_source IS DISTINCT FROM 'FPL_FINAL_RESULT'
    OR source_min_checked_at IS NULL
    OR source_max_checked_at IS NULL
  );
