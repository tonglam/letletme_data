-- Remove the unused tournament-level materialized read model.
-- The event-level snapshot remains the active GraphQL read model.
DROP MATERIALIZED VIEW IF EXISTS public.mv_tournament_snapshot;
