-- Remove manager-related columns from event_live_explains
ALTER TABLE event_live_explains
  DROP COLUMN IF EXISTS mng_win,
  DROP COLUMN IF EXISTS mng_draw,
  DROP COLUMN IF EXISTS mng_loss,
  DROP COLUMN IF EXISTS mng_underdog_win,
  DROP COLUMN IF EXISTS mng_underdog_draw,
  DROP COLUMN IF EXISTS mng_clean_sheets,
  DROP COLUMN IF EXISTS mng_goals_scored;

