import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

import {
  inspectMigrationHistory,
  selectMigrationFilesForLedger,
  selectMigrationFilesThrough,
  selectSqlMigrationLedger,
} from '../../scripts/migration-history';
import {
  getSqlMigrationExecutionContents,
  getSqlMigrationLocalTimeouts,
  getSqlMigrationPreconditions,
} from '../../scripts/sql-migration-compatibility';

describe('migration history inspection', () => {
  test('supports an exact rehearsal boundary without silently accepting a typo', () => {
    const files = ['0088_validate.sql', '0089_prepare.sql', '0090_activate.sql'];

    expect(selectMigrationFilesThrough(files, undefined)).toEqual(files);
    expect(selectMigrationFilesThrough(files, '0089_prepare.sql')).toEqual([
      '0088_validate.sql',
      '0089_prepare.sql',
    ]);
    expect(() => selectMigrationFilesThrough(files, '0089_missing.sql')).toThrow(
      'unknown --through migration: 0089_missing.sql',
    );
  });

  test('switches ledger authority only at the 0090 compatibility boundary', () => {
    expect(selectSqlMigrationLedger('r', false)).toBe('public');
    expect(selectSqlMigrationLedger('r', true)).toBe('public');
    expect(selectSqlMigrationLedger('v', true)).toBe('ops');
    expect(selectSqlMigrationLedger(null, true)).toBe('ops');
    expect(selectSqlMigrationLedger(null, false)).toBe('public');
  });

  test('accepts unapplied migrations after the applied tail', () => {
    expect(
      inspectMigrationHistory(
        ['0031_first.sql', '0032_second.sql', '0033_third.sql'],
        ['0031_first.sql', '0032_second.sql'],
      ),
    ).toEqual({
      missing: [],
      backdated: [],
      latestApplied: '0032_second.sql',
    });
  });

  test('reports missing ledger files and migrations inserted before the applied tail', () => {
    expect(
      inspectMigrationHistory(
        ['0030_backdated.sql', '0031_first.sql', '0033_third.sql'],
        ['0031_first.sql', '0032_missing.sql'],
      ),
    ).toEqual({
      missing: ['0032_missing.sql'],
      backdated: ['0030_backdated.sql'],
      latestApplied: '0032_missing.sql',
    });
  });

  test('has no applied tail for a fresh database', () => {
    expect(inspectMigrationHistory(['0006_first.sql'], [])).toEqual({
      missing: [],
      backdated: [],
      latestApplied: null,
    });
  });

  test('keeps ledgered convergence filenames while suppressing unledgered aliases', () => {
    const files = [
      '0050_entry_event_result_rich_checkpoint.sql',
      '0072_entry_event_result_rich_checkpoint.sql',
      '0071_drop_tournament_snapshot_materialized_view.sql',
    ];

    expect(
      selectMigrationFilesForLedger(files, ['0071_drop_tournament_snapshot_materialized_view.sql']),
    ).toEqual([
      '0072_entry_event_result_rich_checkpoint.sql',
      '0071_drop_tournament_snapshot_materialized_view.sql',
    ]);
    expect(
      selectMigrationFilesForLedger(files, ['0050_entry_event_result_rich_checkpoint.sql']),
    ).toContain('0050_entry_event_result_rich_checkpoint.sql');

    expect(
      selectMigrationFilesForLedger(
        [
          '0050_create_understat_provider_tables.sql',
          '0050_entry_event_result_rich_checkpoint.sql',
          '0072_entry_event_result_rich_checkpoint.sql',
        ],
        ['0050_entry_event_result_rich_checkpoint.sql'],
      ),
    ).toEqual(['0050_entry_event_result_rich_checkpoint.sql']);
  });

  test('places every tournament lifecycle migration after the deployed Live tail', () => {
    const files = readdirSync('migrations')
      .filter((file) => file.endsWith('.sql'))
      .sort();
    const applied = files.filter((file) => file <= '0039_add_live_snapshot_write_fence.sql');

    expect(inspectMigrationHistory(files, applied)).toMatchObject({
      missing: [],
      backdated: [],
      latestApplied: '0039_add_live_snapshot_write_fence.sql',
    });
    expect(files.filter((file) => file.includes('tournament_lifecycle_progress'))).toEqual([
      '0040_tournament_lifecycle_progress.sql',
    ]);
  });

  test('keeps rich result checkpoints after the current migration tail', () => {
    const files = readdirSync('migrations')
      .filter((file) => file.endsWith('.sql'))
      .sort();

    const applied = files.filter((file) => file <= '0049_core_snapshot_authority.sql');
    expect(inspectMigrationHistory(files, applied)).toMatchObject({
      missing: [],
      backdated: [],
      latestApplied: '0049_core_snapshot_authority.sql',
    });
    expect(files).toContain('0072_entry_event_result_rich_checkpoint.sql');
    expect(files).toContain('0073_event_data_checked_at.sql');
    expect(files).toContain('0074_replace_player_picker_rpc.sql');
  });

  test('preserves the historical production tail before new convergence migrations', () => {
    const files = readdirSync('migrations')
      .filter((file) => file.endsWith('.sql'))
      .sort();
    const applied = files.filter(
      (file) => file <= '0071_drop_tournament_snapshot_materialized_view.sql',
    );

    expect(inspectMigrationHistory(files, applied)).toEqual({
      missing: [],
      backdated: [],
      latestApplied: '0071_drop_tournament_snapshot_materialized_view.sql',
    });
    expect(files).toContain('0050_create_understat_provider_tables.sql');
    expect(files).toContain('0069_standardize_event_live_summaries_to_season_aggregate.sql');
    expect(files).toContain('0072_entry_event_result_rich_checkpoint.sql');
    expect(files).toContain('0075_entry_transfer_source_checkpoint.sql');
    expect(files).toContain('0076_restore_tournament_snapshot_materialized_view.sql');
    expect(files).toContain('0077_restore_tournament_compatibility_views.sql');
    expect(files).toContain('0078_restore_event_live_summary_runtime_columns.sql');
  });

  test('preserves the deployed 0079 history tail before v3 activation', () => {
    const files = [
      '0079_align_fpl_event_history.sql',
      '0079_create_v3_ops_and_roles.sql',
      '0080_create_v3_fpl_dimensions.sql',
    ];
    const productionTail = ['0079_align_fpl_event_history.sql'];
    const migration = readFileSync('migrations/0079_align_fpl_event_history.sql', 'utf8');

    expect(inspectMigrationHistory(files, productionTail)).toEqual({
      missing: [],
      backdated: [],
      latestApplied: '0079_align_fpl_event_history.sql',
    });
    expect(createHash('sha256').update(migration, 'utf8').digest('hex')).toBe(
      '4c96e8c932248b17d0aaef3449d99f765389eb951ac2e03dac5dafbc64630ec3',
    );
  });
});

describe('runtime compatibility migrations', () => {
  test('gates restored selection stats and clears incompatible season aggregates', () => {
    const selectionView = readFileSync(
      'migrations/0077_restore_tournament_compatibility_views.sql',
      'utf8',
    );
    const summaryMigration = readFileSync(
      'migrations/0078_restore_event_live_summary_runtime_columns.sql',
      'utf8',
    );

    expect(selectionView).toContain('ready_tournament.standings_ready_at IS NOT NULL');
    expect(summaryMigration).toContain(
      'TRUNCATE TABLE public.event_live_summaries RESTART IDENTITY',
    );
    expect(summaryMigration).not.toContain('MAX(live.event_id)');
  });
});

describe('public Data API lockdown migration', () => {
  test('is scoped to Data-owned relations in the shared public schema', () => {
    const migration = readFileSync('migrations/0033_lock_down_public_data_api.sql', 'utf8');

    expect(migration).toContain('target_tables text[]');
    expect(migration).toMatch(/'events'/);
    expect(migration).toMatch(/'tournament_infos'/);
    expect(migration).not.toContain('ON ALL TABLES IN SCHEMA public');
    expect(migration).not.toContain('ALTER DEFAULT PRIVILEGES');
  });
});

describe('GraphQL read RPC migration', () => {
  test('keeps the applied migration immutable and replaces the RPC at the tail', () => {
    const applied = readFileSync('migrations/0043_create_graphql_read_rpcs.sql', 'utf8');
    const replacement = readFileSync('migrations/0074_replace_player_picker_rpc.sql', 'utf8');
    const drop = replacement.indexOf(
      'DROP FUNCTION IF EXISTS public.get_players_for_picker(integer, integer);',
    );
    const create = replacement.indexOf('CREATE FUNCTION public.get_players_for_picker(');

    expect(applied).toContain(
      'DROP FUNCTION IF EXISTS public.get_players_for_picker(integer, integer);',
    );
    expect(createHash('sha256').update(applied, 'utf8').digest('hex')).toBe(
      '2b9044286ce634077c01be9168ca907b3ecba05c25fe092a619d2065d4f80701',
    );
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(drop);
  });

  test('prepares only a still-pending 0043 for the legacy overload', () => {
    expect(getSqlMigrationPreconditions('0043_create_graphql_read_rpcs.sql')).toEqual([
      'DROP FUNCTION IF EXISTS public.get_players_for_picker(integer, integer);',
    ]);
    expect(getSqlMigrationPreconditions('0074_replace_player_picker_rpc.sql')).toEqual([]);
  });
});

describe('legacy migration transaction compatibility', () => {
  test('removes nested transaction control without changing migration source checksums', () => {
    const source = 'BEGIN;\nUPDATE public.example SET value = 1;\nCOMMIT;\n';

    expect(getSqlMigrationExecutionContents('0066_repair_fpl_team_archive_names.sql', source)).toBe(
      '\nUPDATE public.example SET value = 1;\n',
    );
    expect(
      getSqlMigrationExecutionContents('0072_entry_event_result_rich_checkpoint.sql', source),
    ).toBe(source);
  });

  test('extracts local timeout budgets for a prior protocol round trip', () => {
    expect(
      getSqlMigrationLocalTimeouts(`
        SET LOCAL lock_timeout = '5s';
        SET LOCAL statement_timeout = '10min';
      `),
    ).toEqual({ lockTimeout: '5s', statementTimeout: '10min' });
    expect(getSqlMigrationLocalTimeouts('SELECT 1;')).toEqual({});
  });
});

describe('player market snapshot migration', () => {
  test('creates a unique complete-day store behind the service trust boundary', () => {
    const migration = readFileSync('migrations/0037_create_player_market_snapshots.sql', 'utf8');

    expect(migration).toContain('player_market_snapshots');
    expect(migration).toContain('snapshot_date, element_id');
    expect(migration).toContain('selected_by_percent BETWEEN 0 AND 100');
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON TABLE');
  });
});

describe('tournament lifecycle progress migration', () => {
  test('restores readiness only for legacy tournaments with canonical structure', () => {
    const migration = readFileSync('migrations/0040_tournament_lifecycle_progress.sql', 'utf8');

    expect(migration).toMatch(/setup_status = 'ready'/);
    expect(migration).toMatch(/FROM public\.tournament_entries/);
    expect(migration).toMatch(/FROM public\.tournament_groups/);
    expect(migration).toMatch(/FROM public\.tournament_knockouts/);
  });
});

describe('core snapshot authority migration', () => {
  test('installs a singleton revision authority outside the client Data API', () => {
    const migration = readFileSync('migrations/0049_core_snapshot_authority.sql', 'utf8');

    expect(migration).toContain('core_snapshot_revision_seq');
    expect(migration).toContain('core_snapshot_authority');
    expect(migration).toContain('CHECK (singleton_id = 1)');
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON TABLE');
    expect(migration).toContain('REVOKE ALL ON SEQUENCE');
    expect(migration).toContain('price_source_checked_at');
  });
});

describe('entry result rich checkpoint migration', () => {
  test('follows core authority and preserves the existing table security boundary', () => {
    const migration = readFileSync(
      'migrations/0072_entry_event_result_rich_checkpoint.sql',
      'utf8',
    );

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS rich_synced_at timestamptz');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS source_checked_at timestamptz');
    expect(migration).not.toContain('GRANT');
  });
});

describe('event finalization checkpoint migration', () => {
  test('adds a stable cutoff without changing the existing table security boundary', () => {
    const migration = readFileSync('migrations/0073_event_data_checked_at.sql', 'utf8');

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS data_checked_at timestamptz');
    expect(migration).toContain('WHERE data_checked = true');
    expect(migration).toContain('statement_timestamp()');
    expect(migration).not.toContain('GRANT');
  });
});

describe('event live summary season aggregate migration', () => {
  test('removes event/team dimensions and rebuilds from event-live facts', () => {
    const migration = readFileSync(
      'migrations/0069_standardize_event_live_summaries_to_season_aggregate.sql',
      'utf8',
    );

    expect(migration).toContain('DROP COLUMN IF EXISTS event_id CASCADE');
    expect(migration).toContain('DROP COLUMN IF EXISTS team_id CASCADE');
    expect(migration).toContain('FROM public.event_lives AS live');
    expect(migration).toContain('FROM public.event_lives_history AS live');
    expect(migration).toContain('GROUP BY live.season, live.element_id, player.type');
  });
});

describe('Understat v3 runtime integration migration', () => {
  test('adds bridge idempotency, independent player references, and one sync contract', () => {
    const migration = readFileSync('migrations/0090_zzzz_integrate_understat_runtime.sql', 'utf8');

    expect(migration).toContain('ADD CONSTRAINT bridge_entity_links_pair_unique');
    expect(migration).toContain('UNIQUE NULLS NOT DISTINCT');
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS understat_player_team_team_season_fk');
    expect(migration).toContain('ADD CONSTRAINT understat_player_team_season_fk');
    expect(migration).toContain('REFERENCES understat.seasons(season_code)');
    expect(migration).toContain('ADD CONSTRAINT understat_player_team_team_fk');
    expect(migration).toContain('REFERENCES understat.teams(team_id)');
    expect(migration).toContain('DROP TYPE IF EXISTS understat.lane');
    expect(migration).toContain('DROP TYPE IF EXISTS understat.sync_item_status');
    expect(migration).toContain('DROP TYPE IF EXISTS understat.sync_mode');
    expect(migration).toContain('DROP TYPE IF EXISTS understat.sync_run_status');
    expect(migration).toContain('DROP TYPE IF EXISTS understat.sync_trigger');
    expect(migration).not.toContain('CASCADE');
    expect(migration).not.toMatch(/redis/i);
    expect(migration).not.toContain('public.understat');
  });
});
