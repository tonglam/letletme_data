ALTER TABLE event_live_explains
  DROP COLUMN IF EXISTS mng_win_points,
  DROP COLUMN IF EXISTS mng_draw_points,
  DROP COLUMN IF EXISTS mng_loss_points,
  DROP COLUMN IF EXISTS mng_underdog_win_points,
  DROP COLUMN IF EXISTS mng_underdog_draw_points,
  DROP COLUMN IF EXISTS mng_clean_sheets_points,
  DROP COLUMN IF EXISTS mng_goals_scored_points;
