import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';

import {
  MY_FPL_SNAPSHOT_INVALIDATION_REASON,
  MY_FPL_SNAPSHOT_INVALIDATE_SCRIPT,
  parseMyFplSnapshotInvalidationResult,
} from '../../src/services/my-fpl-snapshot-invalidation.service';

const migration = readFileSync('migrations/0065_my_fpl_snapshot_invalidation_outbox.sql', 'utf8');

describe('My FPL snapshot invalidation outbox contract', () => {
  test('uses the fixed tournament deletion reason and durable schema', () => {
    expect(MY_FPL_SNAPSHOT_INVALIDATION_REASON).toBe('TOURNAMENT_DELETED');
    expect(migration).toContain('CREATE TABLE competition.my_fpl_snapshot_invalidation_outbox');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX my_fpl_snapshot_invalidation_outbox_revision_key',
    );
    expect(migration).toContain('FOREIGN KEY (season_id) REFERENCES fpl.seasons');
    expect(migration).toContain('FOREIGN KEY (season_id, event_id) REFERENCES fpl.events');
    expect(migration).not.toContain('REFERENCES competition.my_fpl_snapshot_publications');
    expect(migration).not.toContain('REFERENCES competition.tournaments');
    expect(migration).toContain('available_at timestamptz NOT NULL DEFAULT now()');
    expect(migration).toContain(
      'CHECK (reason = ' +
        String.fromCharCode(39) +
        'TOURNAMENT_DELETED' +
        String.fromCharCode(39) +
        ')',
    );
    expect(migration).toContain(
      'status IN (' +
        String.fromCharCode(39) +
        'PENDING' +
        String.fromCharCode(39) +
        ', ' +
        String.fromCharCode(39) +
        'FAILED' +
        String.fromCharCode(39) +
        ')',
    );
  });

  test('accepts only the four CAS outcomes', () => {
    expect(parseMyFplSnapshotInvalidationResult(['absent'])).toBe('absent');
    expect(parseMyFplSnapshotInvalidationResult(['deleted'])).toBe('deleted');
    expect(parseMyFplSnapshotInvalidationResult(['malformed_deleted'])).toBe('malformed_deleted');
    expect(parseMyFplSnapshotInvalidationResult(['different'])).toBe('different');
    expect(() => parseMyFplSnapshotInvalidationResult(['unknown'])).toThrow(
      'My FPL Redis manifest invalidation failed',
    );
  });

  test('CAS script never deletes a pointer with a different revision', () => {
    expect(MY_FPL_SNAPSHOT_INVALIDATE_SCRIPT).toContain(
      'tonumber(current.revision) ~= tonumber(ARGV[1])',
    );
    expect(MY_FPL_SNAPSHOT_INVALIDATE_SCRIPT).toContain(
      'return {' + String.fromCharCode(39) + 'different' + String.fromCharCode(39) + '}',
    );
    expect(MY_FPL_SNAPSHOT_INVALIDATE_SCRIPT).toContain(
      'return {' + String.fromCharCode(39) + 'absent' + String.fromCharCode(39) + '}',
    );
    expect(MY_FPL_SNAPSHOT_INVALIDATE_SCRIPT).toContain(
      'return {' + String.fromCharCode(39) + 'malformed_deleted' + String.fromCharCode(39) + '}',
    );
  });
});
