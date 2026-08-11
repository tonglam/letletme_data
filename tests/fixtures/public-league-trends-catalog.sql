CREATE TABLE public.public_league_trends_catalog (
  tournament_id integer PRIMARY KEY REFERENCES public.tournament_infos(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT false,
  published_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION public.search_players_for_picker(
  p_query text,
  p_limit integer,
  p_cursor integer,
  p_position integer,
  p_team_id integer,
  p_min_price integer,
  p_max_price integer
)
RETURNS TABLE (
  id integer,
  web_name text,
  element_type smallint,
  team_id integer,
  team_name text,
  team_short_name text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    player.id,
    player.web_name,
    player.type::smallint AS element_type,
    player.team_id,
    team.name AS team_name,
    team.short_name AS team_short_name
  FROM public.players player
  JOIN public.teams team ON team.id = player.team_id
  WHERE player.id > COALESCE(p_cursor, 0)
    AND length(trim(p_query)) > 0
    AND strpos(lower(player.web_name), lower(trim(p_query))) > 0
    AND (p_position IS NULL OR player.type = p_position)
    AND (p_team_id IS NULL OR player.team_id = p_team_id)
    AND (p_min_price IS NULL OR player.price >= p_min_price)
    AND (p_max_price IS NULL OR player.price <= p_max_price)
  ORDER BY player.id
  LIMIT GREATEST(1, LEAST(p_limit, 200));
$function$;

INSERT INTO public.tournament_infos (
  id,
  name,
  creator,
  admin_entry_id,
  league_id,
  league_type,
  total_team_num,
  tournament_mode,
  group_mode,
  knockout_mode,
  state
)
OVERRIDING SYSTEM VALUE
VALUES (
  900001,
  'CI public league',
  'ci-public-league-owner',
  900001,
  900001,
  'classic',
  1,
  'normal',
  'no_group',
  'no_knockout',
  'inactive'
);

INSERT INTO competition.entries (
  season_id,
  entry_id,
  entry_name,
  player_name
)
SELECT
  season.season_id,
  900001,
  'CI public league entry',
  'CI public league owner'
FROM fpl.seasons season
WHERE season.season_code = '2627';

INSERT INTO competition.tournaments (
  tournament_id,
  season_id,
  name,
  creator,
  admin_entry_id,
  league_id,
  league_type,
  total_team_num,
  tournament_mode,
  group_mode,
  group_auto_averages,
  knockout_mode,
  state
)
SELECT
  900001,
  season.season_id,
  'CI public league',
  'ci-public-league-owner',
  900001,
  900001,
  'classic',
  1,
  'normal',
  'no_group',
  false,
  'no_knockout',
  'inactive'
FROM fpl.seasons season
WHERE season.season_code = '2627';

INSERT INTO competition.tournament_entries (
  tournament_id,
  season_id,
  league_id,
  entry_id
)
SELECT
  900001,
  season.season_id,
  900001,
  900001
FROM fpl.seasons season
WHERE season.season_code = '2627';

INSERT INTO public.public_league_trends_catalog (
  tournament_id,
  display_name,
  sort_order,
  enabled
)
VALUES (900001, 'CI public league', 7, true);

CREATE FUNCTION public.touch_public_league_trends_catalog_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$function$;

CREATE TRIGGER public_league_trends_catalog_touch_updated_at
BEFORE UPDATE ON public.public_league_trends_catalog
FOR EACH ROW
EXECUTE FUNCTION public.touch_public_league_trends_catalog_updated_at();

CREATE INDEX idx_public_league_trends_catalog_enabled_order
  ON public.public_league_trends_catalog (enabled, sort_order, tournament_id);

ALTER TABLE public.public_league_trends_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.public_league_trends_catalog FROM PUBLIC;
GRANT SELECT ON TABLE public.public_league_trends_catalog TO service_role;
