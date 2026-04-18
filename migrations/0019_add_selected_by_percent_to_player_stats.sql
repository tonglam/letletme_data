-- Add selected_by_percent column to player_stats table
ALTER TABLE player_stats
  ADD COLUMN IF NOT EXISTS selected_by_percent TEXT;

-- Add comment for documentation
COMMENT ON COLUMN player_stats.selected_by_percent IS 'Percentage of FPL managers who selected this player (as string, e.g., "15.4")';
