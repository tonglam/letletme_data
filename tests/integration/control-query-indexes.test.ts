import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

test('control indexes preserve live work and avoid scanning terminal history', async () => {
  const db = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  try {
    await db.begin(async (tx) => {
      await tx`CREATE TEMP TABLE acquisition_runs (adapter_kind text, status text, lease_expires_at timestamptz, padding text)`;
      await tx`CREATE TEMP TABLE scheduler_obligations (job_name text, status text, padding text)`;
      await tx`INSERT INTO acquisition_runs SELECT 'X_ACCOUNT', 'SUCCEEDED', NULL, repeat('x', 1000) FROM generate_series(1, 35000)`;
      await tx`INSERT INTO scheduler_obligations SELECT 'retired-job', 'succeeded', repeat('x', 1000) FROM generate_series(1, 35000)`;
      await tx`INSERT INTO acquisition_runs VALUES
        ('X_ACCOUNT','PENDING',NULL,''),
        ('X_SEMANTIC','RUNNING',now()+interval '1 hour',''),
        ('X_ACCOUNT','RUNNING',now()-interval '1 hour',''),
        ('HTTP','PENDING',NULL,''),
        ('X_ACCOUNT','FAILED',NULL,'')`;
      await tx`INSERT INTO scheduler_obligations VALUES
        ('retired-job','pending',''),('retired-job','failed',''),
        ('retired-job','enqueued',''),('retired-job','running',''),
        ('retired-job','retrying',''),('retired-job','skipped',''),
        ('retired-job','irrecoverable',''),('registered-job','pending','')`;
      const countX = `SELECT count(*)::integer AS count FROM pg_temp.acquisition_runs
        WHERE adapter_kind IN ('X_ACCOUNT','X_SEMANTIC') AND status IN ('PENDING','RUNNING')
        AND (lease_expires_at IS NULL OR lease_expires_at > now())`;
      const countOrphans = `SELECT count(*)::integer AS count FROM pg_temp.scheduler_obligations
        WHERE status NOT IN ('succeeded','skipped','irrecoverable') AND job_name NOT IN ('registered-job')`;
      expect((await tx.unsafe(countX))[0].count).toBe(2);
      expect((await tx.unsafe(countOrphans))[0].count).toBe(5);
      // Apply the actual migration to session-private tables; never touch shared fixtures.
      const migration = readFileSync(
        new URL('../../migrations/0096_control_query_partial_indexes.sql', import.meta.url),
        'utf8',
      )
        .replaceAll('content.acquisition_runs', 'pg_temp.acquisition_runs')
        .replaceAll('ops.scheduler_obligations', 'pg_temp.scheduler_obligations');
      await tx.unsafe(migration);
      await tx`ANALYZE pg_temp.acquisition_runs`;
      await tx`ANALYZE pg_temp.scheduler_obligations`;
      for (const [query, expected, index] of [
        [countX, 2, 'content_acquisition_runs_active_x_lease_idx'],
        [countOrphans, 5, 'scheduler_obligations_nonterminal_job_idx'],
      ] as const) {
        expect((await tx.unsafe(query))[0].count).toBe(expected);
        const plan = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
        const tree = plan[0]['QUERY PLAN'][0].Plan;
        expect(JSON.stringify(tree)).toContain(index);
        expect(JSON.stringify(tree)).not.toContain('Seq Scan');
        expect((tree['Local Hit Blocks'] ?? 0) + (tree['Local Read Blocks'] ?? 0)).toBeLessThan(30);
      }
      await tx`DROP TABLE pg_temp.acquisition_runs, pg_temp.scheduler_obligations`;
    });
  } finally {
    await db.end({ timeout: 1 });
  }
}, 30000);
