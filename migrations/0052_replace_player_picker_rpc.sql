-- Replace the player-picker RPC at the migration tail. PostgreSQL cannot
-- change an OUT-parameter row type with CREATE OR REPLACE, and 0043 is already
-- immutable in environments that applied it successfully.
DROP FUNCTION IF EXISTS public.get_players_for_picker(integer, integer);

CREATE FUNCTION public.get_players_for_picker(
  p_limit integer DEFAULT 20,
  p_cursor integer DEFAULT NULL
)
RETURNS TABLE (
  id integer,
  web_name text,
  element_type integer,
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
    p.id,
    p.web_name,
    p.type AS element_type,
    p.team_id,
    t.name AS team_name,
    t.short_name AS team_short_name
  FROM public.players p
  JOIN public.teams t ON t.id = p.team_id
  WHERE p.id > COALESCE(p_cursor, 0)
  ORDER BY p.id ASC
  LIMIT GREATEST(1, LEAST(p_limit, 200));
$function$;

REVOKE ALL ON FUNCTION public.get_players_for_picker(integer, integer) FROM PUBLIC;

DO $permissions$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.get_players_for_picker(integer, integer) FROM %I',
        client_role
      );
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.get_players_for_picker(integer, integer) TO service_role;
  END IF;
END
$permissions$;
