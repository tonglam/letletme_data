-- Remove unused manager-related columns from event_lives
ALTER TABLE event_lives
  DROP COLUMN IF EXISTS mng_win,
  DROP COLUMN IF EXISTS mng_draw,
  DROP COLUMN IF EXISTS mng_loss,
  DROP COLUMN IF EXISTS mng_underdog_win,
  DROP COLUMN IF EXISTS mng_underdog_draw,
  DROP COLUMN IF EXISTS mng_clean_sheets,
  DROP COLUMN IF EXISTS mng_goals_scored;

