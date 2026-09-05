import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const migration = readFileSync('migrations/0091_scheduler_obligation_hot_path_indexes.sql', 'utf8');
const latestWinsMigration = readFileSync('migrations/0093_scheduler_latest_wins_index.sql', 'utf8');
const schema = readFileSync('src/db/schemas/platform/ops.schema.ts', 'utf8');
const quote = String.fromCharCode(39);

describe('scheduler obligation hot-path indexes', () => {
  test('keeps migration and Drizzle declarations aligned', () => {
    for (const indexName of [
      'scheduler_obligations_inflight_job_idx',
      'scheduler_obligations_pending_job_scope_idx',
    ]) {
      expect(migration).toContain(indexName);
      expect(schema).toContain(indexName);
    }
  });

  test('limits both indexes to live scheduler statuses', () => {
    expect(migration).toContain(
      [
        'WHERE status IN (',
        quote,
        'enqueued',
        quote,
        ', ',
        quote,
        'running',
        quote,
        ', ',
        quote,
        'retrying',
        quote,
        ')',
      ].join(''),
    );
    expect(migration).toContain(
      ['WHERE status IN (', quote, 'pending', quote, ', ', quote, 'failed', quote, ')'].join(''),
    );
  });

  test('indexes the immutable latest-wins boundary for only supersedable rows', () => {
    expect(latestWinsMigration).toContain('scheduler_obligations_latest_wins_idx');
    expect(schema).toContain('scheduler_obligations_latest_wins_idx');
    expect(latestWinsMigration).toContain(
      ['evidence->>', quote, 'scheduledDueAtMs', quote].join(''),
    );
    expect(latestWinsMigration).toContain('BETWEEN 0 AND 8640000000000000');
    expect(latestWinsMigration).toContain(
      [
        'WHERE status IN (',
        quote,
        'pending',
        quote,
        ', ',
        quote,
        'failed',
        quote,
        ', ',
        quote,
        'enqueued',
        quote,
        ')',
      ].join(''),
    );
  });
});
