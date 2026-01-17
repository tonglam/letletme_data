import { beforeEach, describe, expect, test } from 'bun:test';

import { getDb } from '../../src/db/singleton';
import { phases } from '../../src/db/schemas/index.schema';
import { phaseRepository } from '../../src/repositories/phases';
import { clearPhasesCache, syncPhases } from '../../src/services/phases.service';

describe('Phases Integration Tests', () => {
  beforeEach(async () => {
    await phaseRepository.deleteAll();
    await clearPhasesCache();
  });

  test('syncPhases persists data (verified via DB count)', async () => {
    const result = await syncPhases();
    expect(result.count).toBeGreaterThan(0);

    const db = await getDb();
    const rows = await db.select().from(phases);
    expect(rows.length).toBe(result.count);
  });

  test('clearPhasesCache completes after sync', async () => {
    await syncPhases();
    await expect(clearPhasesCache()).resolves.toBeUndefined();
  });
});
