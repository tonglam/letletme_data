-- A heartbeat updates source_checked_at without creating a new publication.
-- published_at is allocated by Redis TIME while checkpointed_at is allocated
-- by PostgreSQL. Those timestamps come from different clocks and must not be
-- compared by a database CHECK: clock skew can reject an otherwise complete
-- Redis-first checkpoint and strand the serving path in recovery.
ALTER TABLE competition.live_points_publication_checkpoints
  DROP CONSTRAINT IF EXISTS live_points_publication_checkpoints_time_order;
