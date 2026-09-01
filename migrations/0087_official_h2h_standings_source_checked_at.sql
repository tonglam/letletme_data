ALTER TABLE competition.tournament_groups
  ADD COLUMN IF NOT EXISTS official_source_checked_at timestamptz;

COMMENT ON COLUMN competition.tournament_groups.official_source_checked_at IS
  'Timestamp of the latest successful official H2H standings observation; updated_at is not authoritative source evidence.';
