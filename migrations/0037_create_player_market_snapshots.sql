-- Canonical once-per-calendar-day FPL market observations. The daily player
-- stats job writes one complete upstream roster in a transaction and retries
-- update the same (snapshot_date, element_id) rows.

CREATE TABLE IF NOT EXISTS public.player_market_snapshots (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_date date NOT NULL,
  captured_at timestamptz NOT NULL,
  element_id integer NOT NULL REFERENCES public.players(id),
  player_code integer NOT NULL,
  web_name text NOT NULL,
  first_name text NOT NULL,
  second_name text NOT NULL,
  team_id integer NOT NULL REFERENCES public.teams(id),
  team_name text NOT NULL,
  team_short_name text NOT NULL,
  element_type integer NOT NULL,
  position text NOT NULL,
  price integer NOT NULL,
  selected_by_percent numeric(6, 3) NOT NULL,
  transfers_in integer NOT NULL,
  transfers_out integer NOT NULL,
  transfers_in_event integer NOT NULL,
  transfers_out_event integer NOT NULL,
  status text NOT NULL,
  news text NOT NULL,
  news_added timestamptz,
  chance_of_playing_this_round integer,
  chance_of_playing_next_round integer,
  CONSTRAINT player_market_snapshots_element_type_check CHECK (element_type BETWEEN 1 AND 4),
  CONSTRAINT player_market_snapshots_position_check CHECK (position IN ('GKP', 'DEF', 'MID', 'FWD')),
  CONSTRAINT player_market_snapshots_price_check CHECK (price > 0),
  CONSTRAINT player_market_snapshots_ownership_check CHECK (selected_by_percent BETWEEN 0 AND 100),
  CONSTRAINT player_market_snapshots_transfer_counts_check CHECK (
    transfers_in >= 0 AND transfers_out >= 0
    AND transfers_in_event >= 0 AND transfers_out_event >= 0
  ),
  CONSTRAINT player_market_snapshots_chance_this_check CHECK (
    chance_of_playing_this_round IS NULL OR chance_of_playing_this_round BETWEEN 0 AND 100
  ),
  CONSTRAINT player_market_snapshots_chance_next_check CHECK (
    chance_of_playing_next_round IS NULL OR chance_of_playing_next_round BETWEEN 0 AND 100
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS unique_player_market_snapshot_day
  ON public.player_market_snapshots (snapshot_date, element_id);
CREATE INDEX IF NOT EXISTS idx_player_market_snapshots_element_date
  ON public.player_market_snapshots (element_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_player_market_snapshots_date_ownership
  ON public.player_market_snapshots (snapshot_date, selected_by_percent);

ALTER TABLE public.player_market_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.player_market_snapshots FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.player_market_snapshots_id_seq FROM PUBLIC;

DO $$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE public.player_market_snapshots FROM %I',
        client_role
      );
      EXECUTE format(
        'REVOKE ALL ON SEQUENCE public.player_market_snapshots_id_seq FROM %I',
        client_role
      );
    END IF;
  END LOOP;
END $$;
