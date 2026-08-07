CREATE TABLE IF NOT EXISTS public.fpl_player_fixture_stats (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  season text NOT NULL,
  event_id integer NOT NULL,
  fixture_id integer NOT NULL,
  fixture_code integer NOT NULL,
  element_id integer NOT NULL,
  player_code integer NOT NULL,
  team_id integer NOT NULL,
  team_code integer NOT NULL,
  element_type integer NOT NULL,
  minutes integer NOT NULL,
  starts integer NOT NULL,
  goals integer NOT NULL,
  assists integer NOT NULL,
  own_goals integer NOT NULL,
  yellow_cards integer NOT NULL,
  red_cards integer NOT NULL,
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  CONSTRAINT fpl_player_fixture_stats_season_check CHECK (season ~ '^[0-9]{4}$'),
  CONSTRAINT fpl_player_fixture_stats_element_type_check CHECK (element_type BETWEEN 1 AND 4),
  CONSTRAINT fpl_player_fixture_stats_nonnegative_check CHECK (
    minutes >= 0 AND starts BETWEEN 0 AND 1 AND goals >= 0 AND assists >= 0
    AND own_goals >= 0 AND yellow_cards >= 0 AND red_cards >= 0
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fpl_player_fixture_stats
  ON public.fpl_player_fixture_stats (season, fixture_id, player_code);
CREATE INDEX IF NOT EXISTS idx_fpl_player_fixture_stats_player
  ON public.fpl_player_fixture_stats (season, player_code, fixture_id);
CREATE INDEX IF NOT EXISTS idx_fpl_player_fixture_stats_fixture
  ON public.fpl_player_fixture_stats (season, fixture_id);

ALTER TABLE public.fpl_player_fixture_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fpl_player_fixture_stats FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.fpl_player_fixture_stats_id_seq FROM PUBLIC;

DO $$
DECLARE client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE public.fpl_player_fixture_stats FROM %I', client_role
      );
      EXECUTE format(
        'REVOKE ALL ON SEQUENCE public.fpl_player_fixture_stats_id_seq FROM %I', client_role
      );
    END IF;
  END LOOP;
END $$;
