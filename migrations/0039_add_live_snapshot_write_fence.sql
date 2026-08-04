-- One shared PostgreSQL ordering token per gameweek fences the sparse durable
-- fixture/event-live checkpoints. It prevents a worker whose long-lived
-- advisory-lock transaction was disconnected during upstream or Redis I/O
-- from overwriting rows already written by a newer snapshot.

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS live_snapshot_checked_at timestamptz;
