import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { getDb } from '../../src/db/singleton';
import { durableFinalChipMatches } from '../../src/services/live-publication-v2-checkpoint.service';

describe('Live Points V2 final chip comparison', () => {
  test('rejects an invalid chip without evaluating an unsafe enum cast', async () => {
    const db = await getDb();
    const result = await db.execute(sql`
      SELECT ${durableFinalChipMatches(
        sql`NULL::competition.chip`,
        sql`'future-chip'::text`,
      )} AS matches
    `);

    expect(result[0]?.matches).toBe(false);
  });
});
