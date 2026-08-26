-- A live publication revision can receive a successful-fetch heartbeat without
-- changing its immutable payload. Keep that verification timestamp on the
-- mutable head so CACHE_ONLY can distinguish a recently revalidated head from
-- an old materialization without rewriting immutable score evidence.
ALTER TABLE fpl.manager_event_score_heads
  ADD COLUMN verified_live_checked_at timestamptz;

UPDATE fpl.manager_event_score_heads
SET verified_live_checked_at = COALESCE(
  (
    SELECT materialization.live_checked_at
    FROM fpl.manager_event_score_materializations materialization
    WHERE materialization.season_id = manager_event_score_heads.season_id
      AND materialization.event_id = manager_event_score_heads.event_id
      AND materialization.entry_id = manager_event_score_heads.entry_id
      AND materialization.input_revision = manager_event_score_heads.input_revision
  ),
  updated_at
)
WHERE verified_live_checked_at IS NULL;

ALTER TABLE fpl.manager_event_score_heads
  ALTER COLUMN verified_live_checked_at SET NOT NULL;

COMMENT ON COLUMN fpl.manager_event_score_heads.verified_live_checked_at IS
  'Most recent successful live heartbeat that revalidated this head input; score materializations remain immutable.';
