import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

import { inspectMigrationHistory } from '../../scripts/migration-history';
import { getSqlMigrationPreconditions } from '../../scripts/sql-migration-compatibility';

describe('migration history inspection', () => {
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
    expect(files).toContain('0050_entry_event_result_rich_checkpoint.sql');
    expect(files).toContain('0051_event_data_checked_at.sql');
    expect(files).toContain('0052_replace_player_picker_rpc.sql');
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
    const replacement = readFileSync('migrations/0052_replace_player_picker_rpc.sql', 'utf8');
    const drop = replacement.indexOf(
      'DROP FUNCTION IF EXISTS public.get_players_for_picker(integer, integer);',
    );
    const create = replacement.indexOf('CREATE FUNCTION public.get_players_for_picker(');

    expect(applied).not.toContain(
      'DROP FUNCTION IF EXISTS public.get_players_for_picker(integer, integer);',
    );
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(drop);
  });

  test('prepares only a still-pending 0043 for the legacy overload', () => {
    expect(getSqlMigrationPreconditions('0043_create_graphql_read_rpcs.sql')).toEqual([
      'DROP FUNCTION IF EXISTS public.get_players_for_picker(integer, integer);',
    ]);
    expect(getSqlMigrationPreconditions('0052_replace_player_picker_rpc.sql')).toEqual([]);
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
      'migrations/0050_entry_event_result_rich_checkpoint.sql',
      'utf8',
    );

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS rich_synced_at timestamptz');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS source_checked_at timestamptz');
    expect(migration).not.toContain('GRANT');
  });
});

describe('event finalization checkpoint migration', () => {
  test('adds a stable cutoff without changing the existing table security boundary', () => {
    const migration = readFileSync('migrations/0051_event_data_checked_at.sql', 'utf8');

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS data_checked_at timestamptz');
    expect(migration).toContain('WHERE data_checked = true');
    expect(migration).toContain('statement_timestamp()');
    expect(migration).not.toContain('GRANT');
  });
});
