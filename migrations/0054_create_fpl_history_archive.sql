-- Durable FPL season archives. Current provider tables remain unsuffixed and unchanged.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fpl_season_archive_status') THEN
    CREATE TYPE fpl_season_archive_status AS ENUM (
      'unavailable', 'pending', 'building', 'sealed', 'failed'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.fpl_season_archives (
  season text PRIMARY KEY,
  status fpl_season_archive_status NOT NULL,
  reason text,
  source_core_revision text,
  started_at timestamptz,
  completed_at timestamptz,
  error_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  CONSTRAINT fpl_season_archives_season_check CHECK (season ~ '^[0-9]{4}$'),
  CONSTRAINT fpl_season_archives_unavailable_reason_check CHECK (
    status <> 'unavailable' OR reason IS NOT NULL
  )
);

CREATE TABLE IF NOT EXISTS public.fpl_season_archive_items (
  season text NOT NULL REFERENCES public.fpl_season_archives(season),
  source_table text NOT NULL,
  archive_table text NOT NULL,
  row_count bigint NOT NULL,
  canonical_checksum text NOT NULL,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  PRIMARY KEY (season, source_table),
  CONSTRAINT fpl_season_archive_items_row_count_check CHECK (row_count >= 0),
  CONSTRAINT fpl_season_archive_items_source_table_check CHECK (
    source_table IN (
      'events', 'teams', 'players', 'phases', 'event_fixtures', 'player_stats',
      'event_lives', 'event_live_explains', 'event_live_summaries', 'player_values',
      'player_market_snapshots', 'fpl_player_fixture_stats'
    )
  )
);

CREATE TABLE IF NOT EXISTS public.fpl_event_history (
  season text NOT NULL,
  LIKE public.events INCLUDING STORAGE INCLUDING COMMENTS,
  PRIMARY KEY (season, id)
) PARTITION BY LIST (season);

CREATE TABLE IF NOT EXISTS public.fpl_team_history (
  season text NOT NULL,
  LIKE public.teams INCLUDING STORAGE INCLUDING COMMENTS,
  PRIMARY KEY (season, id),
  UNIQUE (season, code),
  UNIQUE (season, pulse_id)
) PARTITION BY LIST (season);

CREATE TABLE IF NOT EXISTS public.fpl_player_history (
  season text NOT NULL,
  LIKE public.players INCLUDING STORAGE INCLUDING COMMENTS,
  PRIMARY KEY (season, id),
  UNIQUE (season, code),
  FOREIGN KEY (season, team_id) REFERENCES public.fpl_team_history(season, id)
) PARTITION BY LIST (season);

CREATE TABLE IF NOT EXISTS public.fpl_phase_history (
  season text NOT NULL,
  LIKE public.phases INCLUDING STORAGE INCLUDING COMMENTS,
  PRIMARY KEY (season, id),
  FOREIGN KEY (season, start_event) REFERENCES public.fpl_event_history(season, id),
  FOREIGN KEY (season, stop_event) REFERENCES public.fpl_event_history(season, id)
) PARTITION BY LIST (season);

CREATE TABLE IF NOT EXISTS public.fpl_event_fixture_history (
  season text NOT NULL,
  LIKE public.event_fixtures INCLUDING STORAGE INCLUDING COMMENTS,
  PRIMARY KEY (season, id),
  UNIQUE (season, code),
  UNIQUE (season, event_id, team_h_id, team_a_id),
  FOREIGN KEY (season, event_id) REFERENCES public.fpl_event_history(season, id),
  FOREIGN KEY (season, team_h_id) REFERENCES public.fpl_team_history(season, id),
  FOREIGN KEY (season, team_a_id) REFERENCES public.fpl_team_history(season, id)
) PARTITION BY LIST (season);

CREATE TABLE IF NOT EXISTS public.fpl_player_stat_history (
  season text NOT NULL,
  LIKE public.player_stats INCLUDING STORAGE INCLUDING COMMENTS,
  PRIMARY KEY (season, id),
  UNIQUE (season, event_id, element_id),
  FOREIGN KEY (season, event_id) REFERENCES public.fpl_event_history(season, id),
  FOREIGN KEY (season, element_id) REFERENCES public.fpl_player_history(season, id)
) PARTITION BY LIST (season);

CREATE TABLE IF NOT EXISTS public.fpl_event_live_history (
  season text NOT NULL,
  LIKE public.event_lives INCLUDING STORAGE INCLUDING COMMENTS,
  PRIMARY KEY (season, id),
  UNIQUE (season, event_id, element_id),
  FOREIGN KEY (season, event_id) REFERENCES public.fpl_event_history(season, id),
  FOREIGN KEY (season, element_id) REFERENCES public.fpl_player_history(season, id)
) PARTITION BY LIST (season);

CREATE TABLE IF NOT EXISTS public.fpl_event_live_explain_history (
  season text NOT NULL,
  LIKE public.event_live_explains INCLUDING STORAGE INCLUDING COMMENTS,
  PRIMARY KEY (season, id),
  UNIQUE (season, element_id, event_id),
  FOREIGN KEY (season, event_id) REFERENCES public.fpl_event_history(season, id),
  FOREIGN KEY (season, element_id) REFERENCES public.fpl_player_history(season, id)
) PARTITION BY LIST (season);

CREATE TABLE IF NOT EXISTS public.fpl_event_live_summary_history (
  season text NOT NULL,
  LIKE public.event_live_summaries INCLUDING STORAGE INCLUDING COMMENTS,
  PRIMARY KEY (season, id),
  UNIQUE (season, element_id),
  FOREIGN KEY (season, event_id) REFERENCES public.fpl_event_history(season, id),
  FOREIGN KEY (season, element_id) REFERENCES public.fpl_player_history(season, id),
  FOREIGN KEY (season, team_id) REFERENCES public.fpl_team_history(season, id)
) PARTITION BY LIST (season);

CREATE TABLE IF NOT EXISTS public.fpl_player_value_history (
  season text NOT NULL,
  LIKE public.player_values INCLUDING STORAGE INCLUDING COMMENTS,
  PRIMARY KEY (season, id),
  UNIQUE (season, element_id, change_date),
  FOREIGN KEY (season, event_id) REFERENCES public.fpl_event_history(season, id),
  FOREIGN KEY (season, element_id) REFERENCES public.fpl_player_history(season, id)
) PARTITION BY LIST (season);

CREATE TABLE IF NOT EXISTS public.fpl_player_market_snapshot_history (
  season text NOT NULL,
  LIKE public.player_market_snapshots INCLUDING STORAGE INCLUDING COMMENTS,
  PRIMARY KEY (season, id),
  UNIQUE (season, snapshot_date, element_id),
  FOREIGN KEY (season, element_id) REFERENCES public.fpl_player_history(season, id),
  FOREIGN KEY (season, team_id) REFERENCES public.fpl_team_history(season, id)
) PARTITION BY LIST (season);

CREATE TABLE IF NOT EXISTS public.fpl_player_fixture_stat_history (
  LIKE public.fpl_player_fixture_stats INCLUDING STORAGE INCLUDING COMMENTS,
  PRIMARY KEY (season, id),
  UNIQUE (season, fixture_id, player_code),
  FOREIGN KEY (season, event_id) REFERENCES public.fpl_event_history(season, id),
  FOREIGN KEY (season, fixture_id) REFERENCES public.fpl_event_fixture_history(season, id),
  FOREIGN KEY (season, element_id) REFERENCES public.fpl_player_history(season, id),
  FOREIGN KEY (season, player_code) REFERENCES public.fpl_player_history(season, code),
  FOREIGN KEY (season, team_id) REFERENCES public.fpl_team_history(season, id),
  FOREIGN KEY (season, team_code) REFERENCES public.fpl_team_history(season, code)
) PARTITION BY LIST (season);

CREATE INDEX IF NOT EXISTS idx_fpl_archive_items_verified
  ON public.fpl_season_archive_items (season, verified_at);
CREATE INDEX IF NOT EXISTS idx_fpl_player_history_team
  ON public.fpl_player_history (season, team_id);
CREATE INDEX IF NOT EXISTS idx_fpl_fixture_history_event
  ON public.fpl_event_fixture_history (season, event_id);
CREATE INDEX IF NOT EXISTS idx_fpl_fixture_history_kickoff
  ON public.fpl_event_fixture_history (season, kickoff_time);
CREATE INDEX IF NOT EXISTS idx_fpl_player_stat_history_element
  ON public.fpl_player_stat_history (season, element_id, event_id);
CREATE INDEX IF NOT EXISTS idx_fpl_event_live_history_element
  ON public.fpl_event_live_history (season, element_id, event_id);
CREATE INDEX IF NOT EXISTS idx_fpl_event_live_explain_history_element
  ON public.fpl_event_live_explain_history (season, element_id, event_id);
CREATE INDEX IF NOT EXISTS idx_fpl_player_value_history_element
  ON public.fpl_player_value_history (season, element_id, change_date);
CREATE INDEX IF NOT EXISTS idx_fpl_market_history_element
  ON public.fpl_player_market_snapshot_history (season, element_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_fpl_fixture_stat_history_player
  ON public.fpl_player_fixture_stat_history (season, player_code, fixture_id);

CREATE OR REPLACE FUNCTION public.reject_sealed_fpl_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE target_season text;
BEGIN
  target_season := CASE WHEN TG_OP = 'DELETE' THEN OLD.season ELSE NEW.season END;
  IF EXISTS (
    SELECT 1 FROM public.fpl_season_archives
    WHERE season = target_season AND status = 'sealed'
  ) THEN
    RAISE EXCEPTION 'FPL season % is sealed and immutable', target_season
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'fpl_event_history', 'fpl_team_history', 'fpl_player_history', 'fpl_phase_history',
    'fpl_event_fixture_history', 'fpl_player_stat_history', 'fpl_event_live_history',
    'fpl_event_live_explain_history', 'fpl_event_live_summary_history',
    'fpl_player_value_history', 'fpl_player_market_snapshot_history',
    'fpl_player_fixture_stat_history'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS reject_sealed_mutation ON public.%I', table_name);
    EXECUTE format(
      'CREATE TRIGGER reject_sealed_mutation BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.reject_sealed_fpl_history_mutation()',
      table_name
    );
  END LOOP;
END $$;

DO $$
DECLARE table_name text; client_role text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'fpl_season_archives', 'fpl_season_archive_items',
    'fpl_event_history', 'fpl_team_history', 'fpl_player_history', 'fpl_phase_history',
    'fpl_event_fixture_history', 'fpl_player_stat_history', 'fpl_event_live_history',
    'fpl_event_live_explain_history', 'fpl_event_live_summary_history',
    'fpl_player_value_history', 'fpl_player_market_snapshot_history',
    'fpl_player_fixture_stat_history'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', table_name);
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', table_name, client_role);
      END IF;
    END LOOP;
  END LOOP;
END $$;

INSERT INTO public.fpl_season_archives (season, status, reason, completed_at)
VALUES (
  '2526',
  'unavailable',
  'FPL provider data was not persisted before rollover',
  now()
)
ON CONFLICT (season) DO NOTHING;
