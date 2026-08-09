import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';
import { eventRepository } from '../../src/repositories/events';
import { fixtureRepository } from '../../src/repositories/fixtures';
import { playerRepository } from '../../src/repositories/players';
import { seasonRepository } from '../../src/repositories/seasons';
import { teamRepository } from '../../src/repositories/teams';

type NamedFinding = { name: string };

const REPORTING_RELATIONS = [
  { name: 'player_season_summaries', kind: 'v' },
  { name: 'player_value_changes', kind: 'v' },
  { name: 'tournament_entry_event_summaries', kind: 'm' },
  { name: 'tournament_event_results', kind: 'v' },
  { name: 'tournament_selection_stats', kind: 'm' },
] as const;

const PLAYER_SEASON_SUMMARY_COLUMNS = [
  'season_id',
  'element_id',
  'element_type',
  'gameweeks_available',
  'gameweeks_started',
  'minutes',
  'goals_scored',
  'assists',
  'clean_sheets',
  'goals_conceded',
  'own_goals',
  'penalties_saved',
  'penalties_missed',
  'yellow_cards',
  'red_cards',
  'saves',
  'bonus',
  'bps',
  'total_points',
  'defensive_contribution',
  'expected_goals',
  'expected_assists',
  'expected_goal_involvements',
  'expected_goals_conceded',
  'dream_team_appearances',
] as const;

const B0_ACCEPTANCE_ENABLED = process.env.RUN_B0_ACCEPTANCE === '1';
const b0Test = B0_ACCEPTANCE_ENABLED ? test : test.skip;

describe('v3 database trust boundary', () => {
  test('has one explicit current season and one active core publication', async () => {
    const sql = await getDbClient();
    const current = await seasonRepository.findCurrent();
    expect(current).toMatchObject({
      seasonId: 2026,
      seasonCode: '2627',
      lifecycleState: 'preseason',
      isCurrent: true,
    });

    const active = await sql<Array<{ count: number; schema_version: string | null }>>`
      SELECT
        count(*)::integer AS count,
        min(publication.manifest ->> 'schemaVersion') AS schema_version
      FROM ops.dataset_publications publication
      JOIN fpl.seasons season ON season.season_id = publication.season_id
      WHERE publication.dataset = 'fpl:core'
        AND publication.event_id IS NULL
        AND publication.status = 'active'
        AND season.is_current
    `;
    expect(active[0]).toEqual({ count: 1, schema_version: 'v3' });

    const duplicateActiveScopes = await sql<NamedFinding[]>`
      SELECT concat_ws(':', dataset, season_id::text, coalesce(event_id::text, 'core')) AS name
      FROM ops.dataset_publications
      WHERE status = 'active'
      GROUP BY dataset, season_id, event_id
      HAVING count(*) > 1
    `;
    expect(duplicateActiveScopes).toHaveLength(0);

    const invalidPublicationIdentities = await sql<NamedFinding[]>`
      SELECT publication_id::text AS name
      FROM ops.dataset_publications
      WHERE publication_id::text !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         OR (
           manifest ->> 'schemaVersion' = 'v3'
           AND manifest ->> 'planVersion' IS DISTINCT FROM '3.2.5'
         )
    `;
    expect(invalidPublicationIdentities).toHaveLength(0);
  });

  test('exposes exactly the approved reporting views and materialized views', async () => {
    const sql = await getDbClient();
    const relations = await sql<Array<{ name: string; kind: string; populated: boolean }>>`
      SELECT relation.relname AS name, relation.relkind AS kind, relation.relispopulated AS populated
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'reporting'
        AND relation.relkind IN ('v', 'm')
      ORDER BY relation.relname
    `;
    expect(relations.map(({ name, kind }) => ({ name, kind }))).toEqual([...REPORTING_RELATIONS]);
    expect(
      relations.filter((relation) => relation.kind === 'm').every((view) => view.populated),
    ).toBe(true);

    const columns = await sql<NamedFinding[]>`
      SELECT attribute_row.attname AS name
      FROM pg_class relation_row
      JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
      JOIN pg_attribute attribute_row ON attribute_row.attrelid = relation_row.oid
      WHERE namespace_row.nspname = 'reporting'
        AND relation_row.relname = 'player_season_summaries'
        AND attribute_row.attnum > 0
        AND NOT attribute_row.attisdropped
      ORDER BY attribute_row.attnum
    `;
    expect(columns.map((column) => column.name)).toEqual([...PLAYER_SEASON_SUMMARY_COLUMNS]);
    expect(columns.some((column) => column.name === 'event_id')).toBe(false);
    expect(columns.some((column) => column.name === 'team_id')).toBe(false);

    const physicalCopies = await sql<NamedFinding[]>`
      SELECT format('%I.%I', namespace.nspname, relation.relname) AS name
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE relation.relkind IN ('r', 'p')
        AND (
          (namespace.nspname = 'fpl' AND relation.relname = 'event_live_summaries')
          OR (
            namespace.nspname = 'competition'
            AND relation.relname = 'tournament_selection_stats'
          )
        )
    `;
    expect(physicalCopies).toHaveLength(0);
  });

  test('keeps application schemas private and the GraphQL role read-only', async () => {
    const sql = await getDbClient();
    const exposedSchemas = await sql<NamedFinding[]>`
      SELECT format('%s:%s', role_name, schema_name) AS name
      FROM (VALUES ('anon'), ('authenticated'), ('service_role')) role(role_name)
      CROSS JOIN (VALUES ('fpl'), ('competition'), ('reporting'), ('ops')) schema(schema_name)
      WHERE has_schema_privilege(role_name, schema_name, 'USAGE')
         OR has_schema_privilege(role_name, schema_name, 'CREATE')
      ORDER BY name
    `;
    expect(exposedSchemas).toHaveLength(0);

    const clientRelationPrivileges = await sql<NamedFinding[]>`
      SELECT format('%s:%I.%I', role_name, namespace.nspname, relation.relname) AS name
      FROM (VALUES ('anon'), ('authenticated'), ('service_role')) role(role_name)
      CROSS JOIN pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('fpl', 'competition', 'reporting', 'ops')
        AND relation.relkind IN ('r', 'p', 'v', 'm')
        AND has_table_privilege(
          role_name,
          relation.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
      ORDER BY name
    `;
    expect(clientRelationPrivileges).toHaveLength(0);

    const readerWrites = await sql<NamedFinding[]>`
      SELECT format('%I.%I', namespace.nspname, relation.relname) AS name
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('fpl', 'competition', 'reporting', 'ops')
        AND relation.relkind IN ('r', 'p', 'v', 'm')
        AND has_table_privilege(
          'letletme_graphql_reader',
          relation.oid,
          'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
      ORDER BY name
    `;
    expect(readerWrites).toHaveLength(0);

    const unreadableReporting = await sql<NamedFinding[]>`
      SELECT relation.relname AS name
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'reporting'
        AND relation.relkind IN ('v', 'm')
        AND NOT has_table_privilege('letletme_graphql_reader', relation.oid, 'SELECT')
      ORDER BY name
    `;
    expect(unreadableReporting).toHaveLength(0);

    const [readerBoundary] = await sql<Array<{ ops_usage: boolean; reporting_create: boolean }>>`
      SELECT
        has_schema_privilege('letletme_graphql_reader', 'ops', 'USAGE') AS ops_usage,
        has_schema_privilege('letletme_graphql_reader', 'reporting', 'CREATE')
          AS reporting_create
    `;
    expect(readerBoundary).toEqual({ ops_usage: true, reporting_create: false });

    const [publicationBoundary] = await sql<Array<{ readable: boolean; writable: boolean }>>`
      SELECT
        has_table_privilege(
          'letletme_graphql_reader',
          'ops.dataset_publications',
          'SELECT'
        ) AS readable,
        has_table_privilege(
          'letletme_graphql_reader',
          'ops.dataset_publications',
          'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        ) AS writable
    `;
    expect(publicationBoundary).toEqual({ readable: true, writable: false });

    const [cachePreflightBoundary] = await sql<
      Array<{
        broadSelect: boolean;
        exactColumnSelect: boolean;
        columnWritable: boolean;
        tableWritable: boolean;
      }>
    >`
      SELECT
        has_table_privilege(
          'letletme_data_writer',
          'ops.migration_runs',
          'SELECT'
        ) AS "broadSelect",
        bool_and(
          has_column_privilege(
            'letletme_data_writer',
            attribute_row.attrelid,
            attribute_row.attnum,
            'SELECT'
          ) = (attribute_row.attname = ANY (ARRAY['run_id', 'status', 'metadata']))
        ) AS "exactColumnSelect",
        bool_or(
          has_column_privilege(
            'letletme_data_writer',
            attribute_row.attrelid,
            attribute_row.attnum,
            'INSERT'
          )
          OR has_column_privilege(
            'letletme_data_writer',
            attribute_row.attrelid,
            attribute_row.attnum,
            'UPDATE'
          )
          OR has_column_privilege(
            'letletme_data_writer',
            attribute_row.attrelid,
            attribute_row.attnum,
            'REFERENCES'
          )
        ) AS "columnWritable",
        has_table_privilege(
          'letletme_data_writer',
          'ops.migration_runs',
          'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        ) AS "tableWritable"
      FROM pg_attribute attribute_row
      WHERE attribute_row.attrelid = 'ops.migration_runs'::regclass
        AND attribute_row.attnum > 0
        AND NOT attribute_row.attisdropped
      GROUP BY 1, 4
    `;
    expect(cachePreflightBoundary).toEqual({
      broadSelect: false,
      exactColumnSelect: true,
      columnWritable: false,
      tableWritable: false,
    });

    const [writerReportingBoundary] = await sql<
      Array<{
        schemaUsage: boolean;
        schemaCreate: boolean;
        readableRelations: string[] | null;
        writableRelations: string[] | null;
        refreshSelection: boolean;
        refreshEntryEvents: boolean;
      }>
    >`
      SELECT
        has_schema_privilege(
          'letletme_data_writer',
          'reporting',
          'USAGE'
        ) AS "schemaUsage",
        has_schema_privilege(
          'letletme_data_writer',
          'reporting',
          'CREATE'
        ) AS "schemaCreate",
        ARRAY(
          SELECT relation_row.relname
          FROM pg_class relation_row
          WHERE relation_row.relnamespace = 'reporting'::regnamespace
            AND relation_row.relkind IN ('v', 'm')
            AND has_table_privilege(
              'letletme_data_writer',
              relation_row.oid,
              'SELECT'
            )
          ORDER BY relation_row.relname
        ) AS "readableRelations",
        ARRAY(
          SELECT relation_row.relname
          FROM pg_class relation_row
          WHERE relation_row.relnamespace = 'reporting'::regnamespace
            AND relation_row.relkind IN ('v', 'm')
            AND has_table_privilege(
              'letletme_data_writer',
              relation_row.oid,
              'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            )
          ORDER BY relation_row.relname
        ) AS "writableRelations",
        has_function_privilege(
          'letletme_data_writer',
          'reporting.refresh_tournament_selection_stats()',
          'EXECUTE'
        ) AS "refreshSelection",
        has_function_privilege(
          'letletme_data_writer',
          'reporting.refresh_tournament_entry_event_summaries()',
          'EXECUTE'
        ) AS "refreshEntryEvents"
    `;
    expect(writerReportingBoundary).toEqual({
      schemaUsage: true,
      schemaCreate: false,
      readableRelations: ['tournament_entry_event_summaries', 'tournament_selection_stats'],
      writableRelations: [],
      refreshSelection: true,
      refreshEntryEvents: true,
    });

    const [publicLeagueBoundary] = await sql<
      Array<{ readable: boolean; writer_writable: boolean; reader_writable: boolean }>
    >`
      SELECT
        has_table_privilege(
          'letletme_graphql_reader',
          'competition.public_league_trends',
          'SELECT'
        ) AS readable,
        has_table_privilege(
          'letletme_data_writer',
          'competition.public_league_trends',
          'INSERT,UPDATE,DELETE'
        ) AS writer_writable,
        has_table_privilege(
          'letletme_graphql_reader',
          'competition.public_league_trends',
          'INSERT,UPDATE,DELETE'
        ) AS reader_writable
    `;
    expect(publicLeagueBoundary).toEqual({
      readable: true,
      writer_writable: true,
      reader_writable: false,
    });
  });

  test('installs runtime identities, business keys, and one-active enforcement', async () => {
    const sql = await getDbClient();
    const identities = await sql<
      Array<{ name: string; identity: string; default_value: string | null }>
    >`
      SELECT
        format('%I.%I.%I', table_schema, table_name, column_name) AS name,
        is_identity AS identity,
        column_default AS default_value
      FROM information_schema.columns
      WHERE (table_schema, table_name, column_name) IN (
        ('competition', 'entry_season_histories', 'source_history_id'),
        ('competition', 'entry_leagues', 'source_entry_league_id'),
        ('competition', 'entry_event_picks', 'source_pick_row_id'),
        ('competition', 'entry_event_results', 'source_result_id'),
        ('competition', 'entry_event_cup_results', 'source_result_id'),
        ('fpl', 'player_event_snapshots', 'source_snapshot_id'),
        ('fpl', 'player_gameweek_stats', 'source_live_id'),
        ('fpl', 'player_gameweek_scoring_items', 'source_explain_id'),
        ('fpl', 'player_fixture_stats', 'source_fixture_stat_id'),
        ('fpl', 'player_market_snapshots', 'source_snapshot_id')
      )
      ORDER BY name
    `;
    expect(identities).toHaveLength(10);
    expect(
      identities
        .filter((column) => column.name !== 'fpl.player_market_snapshots.source_snapshot_id')
        .every((column) => column.identity === 'YES'),
    ).toBe(true);
    const marketIdentity = identities.find(
      (column) => column.name === 'fpl.player_market_snapshots.source_snapshot_id',
    );
    expect(marketIdentity?.identity).toBe('NO');
    expect(marketIdentity?.default_value).toContain(
      'player_market_snapshots_source_snapshot_id_seq',
    );

    const constraints = await sql<NamedFinding[]>`
      SELECT constraint_name AS name
      FROM information_schema.table_constraints
      WHERE constraint_schema IN ('competition', 'ops')
        AND constraint_name IN (
          'dataset_publications_scope_unique',
          'tournaments_name_key',
          'entry_event_cup_results_business_unique',
          'entry_event_transfers_business_unique',
          'tournament_battle_group_results_business_unique'
        )
      ORDER BY name
    `;
    expect(constraints.map((constraint) => constraint.name)).toEqual([
      'dataset_publications_scope_unique',
      'entry_event_cup_results_business_unique',
      'entry_event_transfers_business_unique',
      'tournament_battle_group_results_business_unique',
      'tournaments_name_key',
    ]);

    const [activeIndex] = await sql<
      Array<{ unique: boolean; nulls_not_distinct: boolean; predicate: string | null }>
    >`
      SELECT
        index_row.indisunique AS unique,
        index_row.indnullsnotdistinct AS nulls_not_distinct,
        pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate
      FROM pg_index index_row
      JOIN pg_class relation ON relation.oid = index_row.indrelid
      JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'ops'
        AND relation.relname = 'dataset_publications'
        AND index_relation.relname = 'dataset_publications_one_active_scope_idx'
    `;
    expect(activeIndex?.unique).toBe(true);
    expect(activeIndex?.nulls_not_distinct).toBe(true);
    expect(activeIndex?.predicate).toMatch(/status = 'active'/);

    const nullEqualBusinessKeys = await sql<Array<{ name: string; nulls_not_distinct: boolean }>>`
      SELECT index_relation.relname AS name, index_row.indnullsnotdistinct AS nulls_not_distinct
      FROM pg_index index_row
      JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
      JOIN pg_namespace namespace ON namespace.oid = index_relation.relnamespace
      WHERE (namespace.nspname, index_relation.relname) IN (
        ('competition', 'entry_event_transfers_business_unique'),
        ('ops', 'dataset_publications_scope_unique')
      )
      ORDER BY name
    `;
    expect([...nullEqualBusinessKeys]).toEqual([
      { name: 'dataset_publications_scope_unique', nulls_not_distinct: true },
      { name: 'entry_event_transfers_business_unique', nulls_not_distinct: true },
    ]);

    const nonDefaultOperatorClasses = await sql<NamedFinding[]>`
      SELECT DISTINCT operator_class.opcname AS name
      FROM pg_index index_row
      JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
      JOIN pg_namespace namespace ON namespace.oid = index_relation.relnamespace
      CROSS JOIN LATERAL unnest(index_row.indclass) class_oid(operator_class_oid)
      JOIN pg_opclass operator_class ON operator_class.oid = class_oid.operator_class_oid
      WHERE namespace.nspname IN ('ops', 'fpl', 'competition', 'understat', 'bridge', 'reporting')
        AND NOT operator_class.opcdefault
    `;
    expect(nonDefaultOperatorClasses).toHaveLength(0);
  });
});

describe('B0 historical repository acceptance', () => {
  b0Test('reads the complete 2526 season through explicit season-scoped repositories', async () => {
    const season = await seasonRepository.requireByCode('2526');
    expect(season).toMatchObject({ seasonId: 2025, seasonCode: '2526', isCurrent: false });

    const [events, teams, fixtures, players] = await Promise.all([
      eventRepository.findAll(season),
      teamRepository.findAll(season),
      fixtureRepository.findAll(season),
      playerRepository.findAll(season),
    ]);

    expect(events).toHaveLength(38);
    expect(events[0]?.id).toBe(1);
    expect(events[37]?.id).toBe(38);
    expect(teams).toHaveLength(20);
    expect(fixtures).toHaveLength(380);
    expect(players).toHaveLength(841);
  });
});
