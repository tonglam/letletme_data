-- Keep queued acquisition reservations distinct from enqueue failures. A
-- pending row confirmed by BullMQ may wait behind the worker concurrency limit
-- and must not be reclaimed by the execution lease timeout.
ALTER TABLE content.acquisition_runs
  ADD COLUMN IF NOT EXISTS enqueue_confirmed_at timestamptz;
