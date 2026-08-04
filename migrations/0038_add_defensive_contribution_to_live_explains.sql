ALTER TABLE event_live_explains
  ADD COLUMN IF NOT EXISTS defensive_contribution integer,
  ADD COLUMN IF NOT EXISTS defensive_contribution_points integer;
