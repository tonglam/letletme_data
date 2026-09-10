import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const migration = readFileSync('migrations/0099_control_plane_recovery_indexes.sql', 'utf8');
const contentSchema = readFileSync('src/db/schemas/content.schema.ts', 'utf8');
const quote = String.fromCharCode(39);

describe('control-plane recovery indexes', () => {
  test('keeps migration and Drizzle declarations aligned', () => {
    for (const indexName of [
      'content_acquisition_runs_trigger_recovery_idx',
      'content_source_media_gates_repair_expiry_idx',
    ]) {
      expect(migration).toContain(indexName);
      expect(contentSchema).toContain(indexName);
    }
  });

  test('matches the exact lease-recovery predicates', () => {
    expect(migration).toContain(
      [
        'WHERE schedule_id IS NULL\n    AND job_kind <> ',
        quote,
        'X_IDENTITY',
        quote,
        '\n    AND status IN (',
        quote,
        'PENDING',
        quote,
        ', ',
        quote,
        'RUNNING',
        quote,
        ')\n    AND lease_expires_at IS NOT NULL',
      ].join(''),
    );
    expect(migration).toContain(
      [
        'WHERE status IN (',
        quote,
        'PENDING',
        quote,
        ', ',
        quote,
        'PARTIAL',
        quote,
        ', ',
        quote,
        'UNAVAILABLE',
        quote,
        ')\n    AND repair_exhausted_at IS NULL',
      ].join(''),
    );
  });
});
