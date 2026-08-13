import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';

describe('player market runtime privilege migrations', () => {
  test('grants the Data writer exactly the sequence capabilities needed for inserts', () => {
    const migration = readFileSync(
      'migrations/0002_grant_player_market_snapshot_sequence.sql',
      'utf8',
    );

    expect(migration).toContain('GRANT SELECT, USAGE');
    expect(migration).toContain('ON SEQUENCE fpl.player_market_snapshots_source_snapshot_id_seq');
    expect(migration).toContain('TO letletme_data_writer');
  });

  test('grants only SELECT on the derived player value view', () => {
    const migration = readFileSync('migrations/0003_grant_player_value_changes_select.sql', 'utf8');

    expect(migration).toMatch(/GRANT\s+SELECT\s+ON TABLE reporting\.player_value_changes/i);
    expect(migration).toContain('TO letletme_data_writer');
    expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)\b/i);
  });

  test.each([
    'src/db/runtime-role-contract.ts',
    'scripts/runtime-login-contract.ts',
    'scripts/migration-login-contract.ts',
  ])('requires SELECT and USAGE independently in %s', (path) => {
    const source = readFileSync(path, 'utf8');
    const sequenceChecks = source.match(
      /has_sequence_privilege\([\s\S]*?'SELECT'[\s\S]*?\)\s+AND\s+has_sequence_privilege\([\s\S]*?'USAGE'[\s\S]*?\)/,
    );

    expect(sequenceChecks).not.toBeNull();
    expect(source).not.toMatch(/'SELECT,USAGE'/);
  });
});
