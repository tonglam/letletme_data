import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';

type NamedFinding = { name: string };

const DATA_TABLES = [
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
  'tournament_selection_stats',
] as const;

const DATA_VIEWS = [
  'mv_tournament_event_snapshot',
  'mv_tournament_snapshot',
  'v_tournament_event_result',
  'v_tournament_event_snapshot',
  'v_tournament_selection_stats',
  'v_tournament_snapshot',
] as const;

const DATA_FUNCTIONS = [
  'get_captain_counts',
  'get_pick_aggregation',
  'get_players_for_picker',
  'get_transfer_aggregation',
] as const;

describe('Database trust boundary', () => {
  test('keeps Data-owned FPL relations fail-closed behind service-owned APIs', async () => {
    const sql = await getDbClient();

    const clientRoles = await sql<NamedFinding[]>`
      SELECT role_name AS name
      FROM (VALUES ('anon'), ('authenticated')) expected(role_name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = expected.role_name)
    `;
    expect(
      clientRoles.map((finding) => finding.name),
      'Supabase client roles must exist before security migrations run',
    ).toEqual([]);

    const tablesWithoutRls = await sql<NamedFinding[]>`
      SELECT format('%I.%I', namespace.nspname, relation.relname) AS name
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p')
        AND relation.relname = ANY(${DATA_TABLES}::text[])
        AND NOT relation.relrowsecurity
      ORDER BY name
    `;
    expect(tablesWithoutRls.map((finding) => finding.name)).toEqual([]);

    const policies = await sql<NamedFinding[]>`
      SELECT format('%I.%I:%I', schemaname, tablename, policyname) AS name
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = ANY(${DATA_TABLES}::text[])
      ORDER BY name
    `;
    expect(policies.map((finding) => finding.name)).toEqual([]);

    const clientTableGrants = await sql<NamedFinding[]>`
      SELECT format('%s:%I.%I', client.role_name, namespace.nspname, relation.relname) AS name
      FROM (VALUES ('anon'), ('authenticated')) client(role_name)
      CROSS JOIN pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm')
        AND relation.relname = ANY(${[...DATA_TABLES, ...DATA_VIEWS]}::text[])
        AND (
          has_table_privilege(client.role_name, relation.oid, 'SELECT')
          OR has_table_privilege(client.role_name, relation.oid, 'INSERT')
          OR has_table_privilege(client.role_name, relation.oid, 'UPDATE')
          OR has_table_privilege(client.role_name, relation.oid, 'DELETE')
        )
      ORDER BY name
    `;
    expect(clientTableGrants.map((finding) => finding.name)).toEqual([]);

    const clientSequenceGrants = await sql<NamedFinding[]>`
      SELECT format('%s:%I.%I', client.role_name, namespace.nspname, relation.relname) AS name
      FROM (VALUES ('anon'), ('authenticated')) client(role_name)
      CROSS JOIN pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      JOIN pg_depend dependency ON dependency.objid = relation.oid
      JOIN pg_class owner_table ON owner_table.oid = dependency.refobjid
      WHERE namespace.nspname = 'public'
        AND relation.relkind = 'S'
        AND owner_table.relname = ANY(${DATA_TABLES}::text[])
        AND (
          has_sequence_privilege(client.role_name, relation.oid, 'USAGE')
          OR has_sequence_privilege(client.role_name, relation.oid, 'SELECT')
          OR has_sequence_privilege(client.role_name, relation.oid, 'UPDATE')
        )
      ORDER BY name
    `;
    expect(clientSequenceGrants.map((finding) => finding.name)).toEqual([]);

    const clientFunctionGrants = await sql<NamedFinding[]>`
      SELECT format('%s:%I.%I(%s)', client.role_name, namespace.nspname, routine.proname,
                    pg_get_function_identity_arguments(routine.oid)) AS name
      FROM (VALUES ('anon'), ('authenticated')) client(role_name)
      CROSS JOIN pg_proc routine
      JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = 'public'
        AND routine.proname = ANY(${DATA_FUNCTIONS}::text[])
        AND has_function_privilege(client.role_name, routine.oid, 'EXECUTE')
      ORDER BY name
    `;
    expect(clientFunctionGrants.map((finding) => finding.name)).toEqual([]);
  });
});
