-- Cup results can arrive before a legacy entry has established its broader
-- snapshot checkpoint. Record their source season directly so a later entry
-- snapshot can preserve current-season cup rows while retiring unowned rows.
ALTER TABLE public.entry_event_cup_results
  ADD COLUMN source_season text;

ALTER TABLE public.entry_event_cup_results
  ADD CONSTRAINT entry_event_cup_results_source_season_format
    CHECK (source_season IS NULL OR source_season ~ '^[0-9]{4}$');

-- Existing rows deliberately remain NULL because their season cannot be
-- proven from event IDs alone. The next authoritative cup sync adopts them.
-- This table is already RLS-enabled and revoked from PUBLIC, anon, and
-- authenticated; adding a column does not change those controls.
