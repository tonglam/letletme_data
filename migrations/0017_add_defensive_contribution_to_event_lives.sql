-- Add defensive_contribution column to event_lives table
ALTER TABLE event_lives
ADD COLUMN IF NOT EXISTS defensive_contribution INTEGER;

COMMENT ON COLUMN event_lives.defensive_contribution IS 'Defensive contribution metric for the player in this event';
