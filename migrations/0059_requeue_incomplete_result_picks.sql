-- A legacy rich result may have a source timestamp but no embedded picks.
-- Requeue it so the finalized result path can fetch and persist the complete
-- immutable pick payload before it is used as score authority.
UPDATE competition.entry_event_results
SET rich_synced_at = NULL,
    updated_at = now()
WHERE rich_synced_at IS NOT NULL
  AND (
    jsonb_typeof(event_picks) <> 'array'
    OR jsonb_array_length(event_picks) <> 15
  );
