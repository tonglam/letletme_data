-- Cumulative stat columns consumed by the tournament snapshot views (0023/0024).
-- Production has these columns (created out-of-band); ADD COLUMN IF NOT EXISTS
-- makes this a no-op there. Lexically sorts before
-- 0023_expand_tournament_event_snapshot_view.sql so fresh installs have the
-- columns before the view is created.

ALTER TABLE public.tournament_points_group_results
  ADD COLUMN IF NOT EXISTS cum_transfers_num integer,
  ADD COLUMN IF NOT EXISTS cum_total_costs integer,
  ADD COLUMN IF NOT EXISTS cum_total_bench_points integer,
  ADD COLUMN IF NOT EXISTS cum_auto_sub_points integer;
