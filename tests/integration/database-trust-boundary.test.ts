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
  'player_market_snapshots',
  'player_values',
  'players',
  'fpl_player_fixture_stats',
  'provider_entity_aliases',
  'provider_entity_links',
  'provider_match_links',
  'teams',
  'tournament_battle_group_results',
  'tournament_entries',
  'tournament_groups',
  'tournament_infos',
  'tournament_knockout_results',
  'tournament_knockouts',
  'tournament_points_group_results',
  'tournament_selection_stats',
  'understat_matches',
  'understat_player_match_stats',
  'understat_player_seasons',
  'understat_player_team_seasons',
  'understat_players',
  'understat_seasons',
  'understat_sync_items',
  'understat_sync_runs',
  'understat_team_match_stats',
  'understat_team_seasons',
  'understat_team_stat_splits',
  'understat_teams',
] as const;

const DATA_VIEWS = ['mv_tournament_event_snapshot', 'v_tournament_event_result'] as const;

const REMOVED_DATA_VIEWS = [
  'v_tournament_event_snapshot',
  'v_tournament_selection_stats',
  'v_tournament_snapshot',
] as const;

const REMOVED_MATERIALIZED_VIEWS = ['mv_tournament_snapshot'] as const;

const DATA_FUNCTIONS = [
  'get_captain_counts',
  'get_pick_aggregation',
  'get_players_for_picker',
  'get_transfer_aggregation',
  'search_players_for_picker',
] as const;

describe('Database trust boundary', () => {
  test('installs private entry sync checkpoints with bounded event ranges', async () => {
    const sql = await getDbClient();
    const columns = await sql<NamedFinding[]>`
      SELECT column_name AS name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'entry_infos'
        AND column_name IN (
          'entry_snapshot_synced_season',
          'entry_snapshot_synced_through_event_id',
          'entry_transfers_synced_season',
          'entry_transfers_synced_through_event_id'
        )
      ORDER BY name
    `;
    expect(columns.map((finding) => finding.name)).toEqual([
      'entry_snapshot_synced_season',
      'entry_snapshot_synced_through_event_id',
      'entry_transfers_synced_season',
      'entry_transfers_synced_through_event_id',
    ]);

    const constraints = await sql<NamedFinding[]>`
      SELECT constraint_name AS name
      FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = 'entry_infos'
        AND constraint_name IN (
          'entry_snapshot_sync_event_range',
          'entry_snapshot_sync_season_format',
          'entry_snapshot_sync_season_pair',
          'entry_transfers_sync_event_range',
          'entry_transfers_sync_season_format',
          'entry_transfers_sync_season_pair'
        )
      ORDER BY name
    `;
    expect(constraints.map((finding) => finding.name)).toEqual([
      'entry_snapshot_sync_event_range',
      'entry_snapshot_sync_season_format',
      'entry_snapshot_sync_season_pair',
      'entry_transfers_sync_event_range',
      'entry_transfers_sync_season_format',
      'entry_transfers_sync_season_pair',
    ]);
  });

  test('installs the tournament materialized views required by runtime refreshes', async () => {
    const sql = await getDbClient();

    const readModels = await sql<NamedFinding[]>`
      SELECT relation.relname AS name
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('v', 'm')
        AND relation.relname = ANY(${DATA_VIEWS}::text[])
      ORDER BY name
    `;
    expect(readModels.map((finding) => finding.name)).toEqual([...DATA_VIEWS]);

    const removedReadModels = await sql<NamedFinding[]>`
      SELECT relation.relname AS name
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind = 'v'
        AND relation.relname = ANY(${REMOVED_DATA_VIEWS}::text[])
      ORDER BY name
    `;
    expect(removedReadModels.map((finding) => finding.name)).toEqual([]);

    const removedMaterializedViews = await sql<NamedFinding[]>`
      SELECT relation.relname AS name
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind = 'm'
        AND relation.relname = ANY(${REMOVED_MATERIALIZED_VIEWS}::text[])
      ORDER BY name
    `;
    expect(removedMaterializedViews.map((finding) => finding.name)).toEqual([]);

    const materializedViews = await sql<NamedFinding[]>`
      SELECT relation.relname AS name
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind = 'm'
        AND relation.relname = ANY(${DATA_VIEWS}::text[])
      ORDER BY name
    `;
    expect(materializedViews.map((finding) => finding.name)).toEqual([
      'mv_tournament_event_snapshot',
    ]);

    const refreshIndexes = await sql<NamedFinding[]>`
      SELECT index_relation.relname AS name
      FROM pg_index index_definition
      JOIN pg_class index_relation ON index_relation.oid = index_definition.indexrelid
      JOIN pg_class owner_relation ON owner_relation.oid = index_definition.indrelid
      JOIN pg_namespace namespace ON namespace.oid = owner_relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND owner_relation.relname IN (
          'mv_tournament_event_snapshot'
        )
        AND index_definition.indisunique
      ORDER BY name
    `;
    expect(refreshIndexes.map((finding) => finding.name)).toEqual(['idx_mv_tes_pk']);

    const inaccessibleToServiceRole = await sql<NamedFinding[]>`
      SELECT expected.name
      FROM (VALUES
        ('mv_tournament_event_snapshot')
      ) expected(name)
      WHERE NOT has_table_privilege(
        'service_role',
        format('public.%I', expected.name),
        'SELECT'
      )
      ORDER BY expected.name
    `;
    expect(inaccessibleToServiceRole.map((finding) => finding.name)).toEqual([]);

    const readFunctions = await sql<NamedFinding[]>`
      SELECT routine.proname AS name
      FROM pg_proc routine
      JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = 'public'
        AND routine.proname = ANY(${DATA_FUNCTIONS}::text[])
      ORDER BY name
    `;
    expect(readFunctions.map((finding) => finding.name)).toEqual([...DATA_FUNCTIONS]);

    const pickerResultTypes = await sql<Array<{ name: string; result: string }>>`
      SELECT
        routine.proname AS name,
        pg_get_function_result(routine.oid) AS result
      FROM pg_proc routine
      JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = 'public'
        AND routine.proname IN ('get_players_for_picker', 'search_players_for_picker')
      ORDER BY name
    `;
    expect(pickerResultTypes).toHaveLength(2);
    for (const picker of pickerResultTypes) {
      expect(picker.result).toContain('element_type integer');
    }

    const functionsInaccessibleToServiceRole = await sql<NamedFinding[]>`
      SELECT routine.proname AS name
      FROM pg_proc routine
      JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = 'public'
        AND routine.proname = ANY(${DATA_FUNCTIONS}::text[])
        AND NOT has_function_privilege('service_role', routine.oid, 'EXECUTE')
      ORDER BY name
    `;
    expect(functionsInaccessibleToServiceRole.map((finding) => finding.name)).toEqual([]);

    const [eventResultViewPrivilege] = await sql<{ allowed: boolean }[]>`
      SELECT has_table_privilege(
        'service_role',
        'public.v_tournament_event_result',
        'SELECT'
      ) AS allowed
    `;
    expect(eventResultViewPrivilege?.allowed).toBe(true);
  });

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
