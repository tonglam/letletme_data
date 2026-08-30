-- A heartbeat updates source_checked_at without creating a new publication.
-- Therefore a later source check is valid even when published_at remains the
-- original content publication time. The durable checkpoint must be after
-- both timestamps.
ALTER TABLE competition.live_points_publication_checkpoints
  DROP CONSTRAINT IF EXISTS live_points_publication_checkpoints_time_order;

ALTER TABLE competition.live_points_publication_checkpoints
  ADD CONSTRAINT live_points_publication_checkpoints_time_order CHECK (
    checkpointed_at >= published_at
    AND checkpointed_at >= source_checked_at
  );
