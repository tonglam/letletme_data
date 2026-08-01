-- The LetLetMe public data plane is GraphQL. Domain tables are canonical
-- service-owned storage, not a browser-facing Supabase Data API.
--
-- Remove the permissive policies introduced by 0029 and revoke client roles
-- from Data-owned FPL relations only. This Supabase project also contains
-- tables owned by Web and other products, so a schema-wide revoke would cross
-- service boundaries and break unrelated applications.
-- Direct database owners and Supabase service_role continue to serve trusted
-- Data and GraphQL processes; anon/authenticated JWT roles get no table access.

DO $$
DECLARE
  relation record;
  policy record;
  routine record;
  client_role text;
  target_tables text[] := ARRAY[
    'entry_event_cup_results',
    'entry_event_picks',
    'entry_event_results',
    'entry_event_transfers',
    'entry_history_infos',
    'entry_infos',
    'entry_league_infos',
    'event_fixtures',
    'event_live_explains',
    'event_live_summaries',
    'event_lives',
    'events',
    'league_event_results',
    'phases',
    'player_stats',
    'player_values',
    'players',
    'teams',
    'tournament_battle_group_results',
    'tournament_entries',
    'tournament_groups',
    'tournament_infos',
    'tournament_knockout_results',
    'tournament_knockouts',
    'tournament_points_group_results',
    'tournament_selection_stats'
  ];
  target_views text[] := ARRAY[
    'mv_tournament_event_snapshot',
    'mv_tournament_snapshot',
    'v_tournament_event_result',
    'v_tournament_event_snapshot',
    'v_tournament_selection_stats',
    'v_tournament_snapshot'
  ];
  target_functions text[] := ARRAY[
    'get_captain_counts',
    'get_pick_aggregation',
    'get_players_for_picker',
    'get_transfer_aggregation'
  ];
BEGIN
  FOR relation IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname = ANY(target_tables)
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', relation.relname);
    FOR policy IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = relation.relname
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', policy.policyname, relation.relname);
    END LOOP;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', relation.relname);

    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated']
    LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', relation.relname, client_role);
      END IF;
    END LOOP;
  END LOOP;

  FOR relation IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('v', 'm')
      AND c.relname = ANY(target_views)
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', relation.relname);
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated']
    LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', relation.relname, client_role);
      END IF;
    END LOOP;
  END LOOP;

  FOR relation IN
    SELECT DISTINCT sequence.relname
    FROM pg_class sequence
    JOIN pg_namespace sequence_namespace ON sequence_namespace.oid = sequence.relnamespace
    JOIN pg_depend dependency ON dependency.objid = sequence.oid
    JOIN pg_class owner_table ON owner_table.oid = dependency.refobjid
    JOIN pg_namespace owner_namespace ON owner_namespace.oid = owner_table.relnamespace
    WHERE sequence_namespace.nspname = 'public'
      AND owner_namespace.nspname = 'public'
      AND sequence.relkind = 'S'
      AND owner_table.relname = ANY(target_tables)
  LOOP
    EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM PUBLIC', relation.relname);
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated']
    LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
        EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM %I', relation.relname, client_role);
      END IF;
    END LOOP;
  END LOOP;

  FOR routine IN
    SELECT procedure.proname, pg_get_function_identity_arguments(procedure.oid) AS arguments
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = ANY(target_functions)
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC',
      routine.proname,
      routine.arguments
    );
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated']
    LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
        EXECUTE format(
          'REVOKE ALL ON FUNCTION public.%I(%s) FROM %I',
          routine.proname,
          routine.arguments,
          client_role
        );
      END IF;
    END LOOP;
  END LOOP;
END $$;
