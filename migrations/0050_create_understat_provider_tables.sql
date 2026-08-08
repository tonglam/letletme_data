-- Understat provider storage follows the deployed 0040-0049 lifecycle series.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'understat_season_state') THEN
    CREATE TYPE understat_season_state AS ENUM ('planned', 'active', 'complete');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.understat_seasons (
  season text PRIMARY KEY,
  source_year integer NOT NULL,
  league text NOT NULL,
  state understat_season_state NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  CONSTRAINT understat_seasons_key_check CHECK (season ~ '^[0-9]{4}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_understat_seasons_league_year
  ON public.understat_seasons (league, source_year);

CREATE TABLE IF NOT EXISTS public.understat_teams (
  id integer PRIMARY KEY,
  title text NOT NULL,
  short_title text,
  first_seen_season text NOT NULL REFERENCES public.understat_seasons(season),
  last_seen_season text NOT NULL REFERENCES public.understat_seasons(season),
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_understat_teams_last_seen_season
  ON public.understat_teams (last_seen_season);

CREATE TABLE IF NOT EXISTS public.understat_matches (
  id integer PRIMARY KEY,
  season text NOT NULL REFERENCES public.understat_seasons(season),
  home_team_id integer NOT NULL REFERENCES public.understat_teams(id),
  away_team_id integer NOT NULL REFERENCES public.understat_teams(id),
  kickoff_at timestamptz NOT NULL,
  is_result boolean NOT NULL DEFAULT false,
  home_goals integer,
  away_goals integer,
  home_xg numeric(14, 8),
  away_xg numeric(14, 8),
  forecast_home_win numeric(10, 8),
  forecast_draw numeric(10, 8),
  forecast_away_win numeric(10, 8),
  source_hash text NOT NULL,
  source_checked_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  CONSTRAINT understat_matches_distinct_teams_check CHECK (home_team_id <> away_team_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_understat_matches_identity
  ON public.understat_matches (season, home_team_id, away_team_id, kickoff_at);
CREATE INDEX IF NOT EXISTS idx_understat_matches_season_kickoff
  ON public.understat_matches (season, kickoff_at);
CREATE INDEX IF NOT EXISTS idx_understat_matches_home_team
  ON public.understat_matches (home_team_id);
CREATE INDEX IF NOT EXISTS idx_understat_matches_away_team
  ON public.understat_matches (away_team_id);
ALTER TABLE public.understat_matches
  ADD COLUMN IF NOT EXISTS source_checked_at timestamptz;
UPDATE public.understat_matches
SET source_checked_at = COALESCE(source_checked_at, last_seen_at, now())
WHERE source_checked_at IS NULL;
ALTER TABLE public.understat_matches ALTER COLUMN source_checked_at SET NOT NULL;

CREATE TABLE IF NOT EXISTS public.understat_team_match_stats (
  match_id integer NOT NULL REFERENCES public.understat_matches(id),
  team_id integer NOT NULL REFERENCES public.understat_teams(id),
  side text NOT NULL,
  xg numeric(14, 8) NOT NULL,
  xga numeric(14, 8) NOT NULL,
  npxg numeric(14, 8) NOT NULL,
  npxga numeric(14, 8) NOT NULL,
  npxgd numeric(14, 8) NOT NULL,
  ppda_att integer NOT NULL,
  ppda_def integer NOT NULL,
  ppda_allowed_att integer NOT NULL,
  ppda_allowed_def integer NOT NULL,
  deep integer NOT NULL,
  deep_allowed integer NOT NULL,
  scored integer NOT NULL,
  missed integer NOT NULL,
  xpoints numeric(14, 8) NOT NULL,
  result text NOT NULL,
  points integer NOT NULL,
  wins integer NOT NULL,
  draws integer NOT NULL,
  losses integer NOT NULL,
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  PRIMARY KEY (match_id, team_id),
  CONSTRAINT understat_team_match_stats_side_check CHECK (side IN ('h', 'a')),
  CONSTRAINT understat_team_match_stats_result_check CHECK (result IN ('w', 'd', 'l'))
);
CREATE INDEX IF NOT EXISTS idx_understat_team_match_stats_team
  ON public.understat_team_match_stats (team_id, match_id);

CREATE TABLE IF NOT EXISTS public.understat_team_seasons (
  season text NOT NULL REFERENCES public.understat_seasons(season),
  team_id integer NOT NULL REFERENCES public.understat_teams(id),
  source_title text NOT NULL,
  source_short_title text,
  games integer NOT NULL,
  wins integer NOT NULL,
  draws integer NOT NULL,
  losses integer NOT NULL,
  goals_for integer NOT NULL,
  goals_against integer NOT NULL,
  points integer NOT NULL,
  xg numeric(14, 8) NOT NULL,
  xga numeric(14, 8) NOT NULL,
  npxg numeric(14, 8) NOT NULL,
  npxga numeric(14, 8) NOT NULL,
  npxgd numeric(14, 8) NOT NULL,
  xpoints numeric(14, 8) NOT NULL,
  deep integer NOT NULL,
  deep_allowed integer NOT NULL,
  ppda_att integer NOT NULL,
  ppda_def integer NOT NULL,
  ppda_allowed_att integer NOT NULL,
  ppda_allowed_def integer NOT NULL,
  source_hash text NOT NULL,
  last_synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  PRIMARY KEY (season, team_id)
);
ALTER TABLE public.understat_team_seasons
  ADD COLUMN IF NOT EXISTS source_title text;
ALTER TABLE public.understat_team_seasons
  ADD COLUMN IF NOT EXISTS source_short_title text;
UPDATE public.understat_team_seasons season_row
SET
  source_title = COALESCE(season_row.source_title, team.title),
  source_short_title = COALESCE(season_row.source_short_title, team.short_title)
FROM public.understat_teams team
WHERE team.id = season_row.team_id AND season_row.source_title IS NULL;
ALTER TABLE public.understat_team_seasons ALTER COLUMN source_title SET NOT NULL;

CREATE TABLE IF NOT EXISTS public.understat_team_stat_splits (
  season text NOT NULL REFERENCES public.understat_seasons(season),
  team_id integer NOT NULL REFERENCES public.understat_teams(id),
  dimension text NOT NULL,
  split_key text NOT NULL,
  label text,
  time_minutes integer,
  shots_for integer NOT NULL,
  goals_for integer NOT NULL,
  xg_for numeric(14, 8) NOT NULL,
  shots_against integer NOT NULL,
  goals_against integer NOT NULL,
  xg_against numeric(14, 8) NOT NULL,
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  PRIMARY KEY (season, team_id, dimension, split_key),
  CONSTRAINT understat_team_stat_splits_dimension_check CHECK (
    dimension IN ('situation', 'formation', 'gameState', 'timing', 'shotZone', 'attackSpeed', 'result')
  )
);
CREATE INDEX IF NOT EXISTS idx_understat_team_stat_splits_team
  ON public.understat_team_stat_splits (season, team_id);

CREATE TABLE IF NOT EXISTS public.understat_players (
  id integer PRIMARY KEY,
  name text NOT NULL,
  favorite_position text,
  first_seen_season text NOT NULL REFERENCES public.understat_seasons(season),
  last_seen_season text NOT NULL REFERENCES public.understat_seasons(season),
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_understat_players_last_seen_season
  ON public.understat_players (last_seen_season);

CREATE TABLE IF NOT EXISTS public.understat_player_seasons (
  season text NOT NULL REFERENCES public.understat_seasons(season),
  player_id integer NOT NULL REFERENCES public.understat_players(id),
  source_name text NOT NULL,
  source_team_title text NOT NULL,
  games integer NOT NULL,
  time integer NOT NULL,
  goals integer NOT NULL,
  npg integer NOT NULL,
  assists integer NOT NULL,
  shots integer NOT NULL,
  key_passes integer NOT NULL,
  yellow_cards integer NOT NULL,
  red_cards integer NOT NULL,
  xg numeric(14, 8) NOT NULL,
  npxg numeric(14, 8) NOT NULL,
  xa numeric(14, 8) NOT NULL,
  xg_chain numeric(14, 8) NOT NULL,
  xg_buildup numeric(14, 8) NOT NULL,
  position text NOT NULL,
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  PRIMARY KEY (season, player_id)
);
ALTER TABLE public.understat_player_seasons
  ADD COLUMN IF NOT EXISTS source_name text;
UPDATE public.understat_player_seasons season_row
SET source_name = COALESCE(season_row.source_name, player.name)
FROM public.understat_players player
WHERE player.id = season_row.player_id AND season_row.source_name IS NULL;
ALTER TABLE public.understat_player_seasons ALTER COLUMN source_name SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_understat_player_seasons_season
  ON public.understat_player_seasons (season);

CREATE TABLE IF NOT EXISTS public.understat_player_team_seasons (
  season text NOT NULL REFERENCES public.understat_seasons(season),
  player_id integer NOT NULL REFERENCES public.understat_players(id),
  team_id integer NOT NULL REFERENCES public.understat_teams(id),
  games integer NOT NULL,
  time integer NOT NULL,
  goals integer NOT NULL,
  npg integer NOT NULL,
  assists integer NOT NULL,
  shots integer NOT NULL,
  key_passes integer NOT NULL,
  yellow_cards integer NOT NULL,
  red_cards integer NOT NULL,
  xg numeric(14, 8) NOT NULL,
  npxg numeric(14, 8) NOT NULL,
  xa numeric(14, 8) NOT NULL,
  xg_chain numeric(14, 8) NOT NULL,
  xg_buildup numeric(14, 8) NOT NULL,
  position text NOT NULL,
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  PRIMARY KEY (season, player_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_understat_player_team_seasons_team
  ON public.understat_player_team_seasons (season, team_id);

CREATE TABLE IF NOT EXISTS public.understat_player_match_stats (
  roster_id integer PRIMARY KEY,
  match_id integer NOT NULL REFERENCES public.understat_matches(id),
  player_id integer NOT NULL REFERENCES public.understat_players(id),
  team_id integer NOT NULL REFERENCES public.understat_teams(id),
  player_name text NOT NULL,
  side text NOT NULL,
  position text NOT NULL,
  position_order integer NOT NULL,
  minutes integer NOT NULL,
  started boolean NOT NULL,
  goals integer NOT NULL,
  own_goals integer NOT NULL,
  shots integer NOT NULL,
  key_passes integer NOT NULL,
  assists integer NOT NULL,
  yellow_cards integer NOT NULL,
  red_cards integer NOT NULL,
  xg numeric(14, 8) NOT NULL,
  xa numeric(14, 8) NOT NULL,
  xg_chain numeric(14, 8) NOT NULL,
  xg_buildup numeric(14, 8) NOT NULL,
  roster_in_id integer,
  roster_out_id integer,
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  CONSTRAINT understat_player_match_stats_side_check CHECK (side IN ('h', 'a')),
  CONSTRAINT understat_player_match_stats_minutes_check CHECK (minutes >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_understat_player_match_stats_identity
  ON public.understat_player_match_stats (match_id, player_id, team_id);
CREATE INDEX IF NOT EXISTS idx_understat_player_match_stats_player
  ON public.understat_player_match_stats (player_id, match_id);
CREATE INDEX IF NOT EXISTS idx_understat_player_match_stats_team
  ON public.understat_player_match_stats (team_id, match_id);

DO $$
DECLARE
  table_name text;
  client_role text;
  target_tables text[] := ARRAY[
    'understat_seasons', 'understat_teams', 'understat_matches',
    'understat_team_match_stats', 'understat_team_seasons', 'understat_team_stat_splits',
    'understat_players', 'understat_player_seasons', 'understat_player_team_seasons',
    'understat_player_match_stats'
  ];
BEGIN
  FOREACH table_name IN ARRAY target_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', table_name);
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', table_name, client_role);
      END IF;
    END LOOP;
  END LOOP;
END $$;
