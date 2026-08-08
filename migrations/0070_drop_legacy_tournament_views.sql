-- Remove compatibility views that are no longer part of the runtime contract.
-- Keep the materialized tournament read models and the event-result view.

DROP VIEW IF EXISTS public.v_tournament_snapshot;
DROP VIEW IF EXISTS public.v_tournament_event_snapshot;
DROP VIEW IF EXISTS public.v_tournament_selection_stats;
