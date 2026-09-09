-- A reconciliation execution is distinct from its durable resume intent.
-- Nullable for existing rows; every new execution claims a fresh UUID.
ALTER TABLE competition.tournaments
  ADD COLUMN roster_sync_execution_id uuid;
