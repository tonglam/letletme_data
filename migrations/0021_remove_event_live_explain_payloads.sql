ALTER TABLE event_live_explains
  DROP COLUMN IF EXISTS stats,
  DROP COLUMN IF EXISTS explain,
  DROP COLUMN IF EXISTS modified;
