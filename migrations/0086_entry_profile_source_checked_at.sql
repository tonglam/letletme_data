ALTER TABLE competition.entries
  ADD COLUMN IF NOT EXISTS profile_source_checked_at timestamptz;

COMMENT ON COLUMN competition.entries.profile_source_checked_at IS
  'Timestamp of the latest successful entry-info summary observation; unlike updated_at, transfer and past-season maintenance do not advance it.';
