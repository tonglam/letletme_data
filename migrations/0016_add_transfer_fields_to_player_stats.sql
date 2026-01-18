-- Add transfer fields to player_stats table
ALTER TABLE player_stats
  ADD COLUMN IF NOT EXISTS transfers_in INTEGER,
  ADD COLUMN IF NOT EXISTS transfers_in_event INTEGER,
  ADD COLUMN IF NOT EXISTS transfers_out INTEGER,
  ADD COLUMN IF NOT EXISTS transfers_out_event INTEGER;

-- Add comments for documentation
COMMENT ON COLUMN player_stats.transfers_in IS 'Total transfers in (all-time)';
COMMENT ON COLUMN player_stats.transfers_in_event IS 'Transfers in for this specific event';
COMMENT ON COLUMN player_stats.transfers_out IS 'Total transfers out (all-time)';
COMMENT ON COLUMN player_stats.transfers_out_event IS 'Transfers out for this specific event';
