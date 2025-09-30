-- Migration: Remove unused mng_* fields from player_stats table
-- These fields were never populated from the FPL API

ALTER TABLE player_stats 
  DROP COLUMN IF EXISTS mng_win,
  DROP COLUMN IF EXISTS mng_draw,
  DROP COLUMN IF EXISTS mng_loss,
  DROP COLUMN IF EXISTS mng_underdog_win,
  DROP COLUMN IF EXISTS mng_underdog_draw,
  DROP COLUMN IF EXISTS mng_clean_sheets,
  DROP COLUMN IF EXISTS mng_goals_scored;
