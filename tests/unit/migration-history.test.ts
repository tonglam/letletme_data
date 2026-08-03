import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { inspectMigrationHistory } from '../../scripts/migration-history';

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
