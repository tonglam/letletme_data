import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { getDb } from '../../src/db/singleton';
import { runManagerLivePublication } from '../../src/services/manager-live.service';

describe('manager-live publication transaction', () => {
  test('executes repository reads on the pinned Drizzle transaction', async () => {
    const value = await runManagerLivePublication(
      'manager-live-publication-transaction-regression',
      async () => {
        const db = await getDb();
        const rows = await db.execute<{ value: number }>(sql`SELECT 1 AS value`);
        return rows[0]?.value;
      },
    );

    expect(value).toBe(1);
  });
});
