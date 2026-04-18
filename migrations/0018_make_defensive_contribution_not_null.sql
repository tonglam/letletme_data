-- Make defensive_contribution NOT NULL with default value 0
ALTER TABLE event_lives
  ALTER COLUMN defensive_contribution SET DEFAULT 0,
  ALTER COLUMN defensive_contribution SET NOT NULL;

-- Update existing NULL values to 0
UPDATE event_lives
SET defensive_contribution = 0
WHERE defensive_contribution IS NULL;

COMMENT ON COLUMN event_lives.defensive_contribution IS 'Defensive contribution metric for the player in this event (default: 0)';
