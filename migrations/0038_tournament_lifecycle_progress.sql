CREATE TYPE public.tournament_setup_phase AS ENUM (
  'queued',
  'syncing_entries',
  'building_structure',
  'calculating_standings',
  'enriching_history',
  'finalizing',
  'ready',
  'failed'
);

CREATE TYPE public.tournament_roster_mode AS ENUM ('snapshot', 'official_sync');

ALTER TABLE public.tournament_infos
  ADD COLUMN source_league_name text,
  ADD COLUMN roster_mode public.tournament_roster_mode NOT NULL DEFAULT 'snapshot',
  ADD COLUMN roster_sync_status public.tournament_setup_status,
  ADD COLUMN roster_last_synced_at timestamptz,
  ADD COLUMN roster_sync_error text,
  ADD COLUMN setup_phase public.tournament_setup_phase NOT NULL DEFAULT 'queued',
  ADD COLUMN setup_completed_units integer NOT NULL DEFAULT 0,
  ADD COLUMN setup_total_units integer NOT NULL DEFAULT 0,
  ADD COLUMN setup_progress_updated_at timestamptz,
  ADD COLUMN standings_ready_at timestamptz,
  ADD COLUMN setup_warning_count integer NOT NULL DEFAULT 0;

UPDATE public.tournament_infos
SET
  setup_phase = CASE setup_status
    WHEN 'ready' THEN 'ready'::public.tournament_setup_phase
    WHEN 'failed' THEN 'failed'::public.tournament_setup_phase
    WHEN 'processing' THEN 'syncing_entries'::public.tournament_setup_phase
    ELSE 'queued'::public.tournament_setup_phase
  END,
  standings_ready_at = CASE
    WHEN setup_status = 'ready' THEN COALESCE(setup_finished_at, updated_at, now())
    ELSE NULL
  END,
  setup_warning_count = CASE
    WHEN setup_status = 'ready' AND setup_error IS NOT NULL THEN 1
    ELSE 0
  END,
  setup_progress_updated_at = COALESCE(setup_finished_at, setup_started_at, updated_at, now());

ALTER TABLE public.tournament_infos
  ADD CONSTRAINT tournament_setup_progress_non_negative
    CHECK (setup_completed_units >= 0 AND setup_total_units >= 0),
  ADD CONSTRAINT tournament_setup_progress_bounded
    CHECK (setup_total_units = 0 OR setup_completed_units <= setup_total_units),
  ADD CONSTRAINT tournament_setup_warning_count_non_negative
    CHECK (setup_warning_count >= 0);

CREATE INDEX idx_tournament_setup_heartbeat
  ON public.tournament_infos (setup_status, setup_progress_updated_at);

-- tournament_infos is already RLS-enabled and revoked from PUBLIC, anon, and
-- authenticated by migrations 0029 and 0033. This migration adds no exposed
-- table, view, sequence, function, or policy; trusted server roles retain their
-- existing table privileges.
