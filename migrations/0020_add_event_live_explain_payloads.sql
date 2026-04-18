ALTER TABLE event_live_explains
  ADD COLUMN IF NOT EXISTS stats jsonb,
  ADD COLUMN IF NOT EXISTS explain jsonb,
  ADD COLUMN IF NOT EXISTS modified boolean DEFAULT false NOT NULL;
