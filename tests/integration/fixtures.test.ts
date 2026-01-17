import { beforeEach, describe, expect, test } from 'bun:test';

import { getDb } from '../../src/db/singleton';
import { eventFixtures } from '../../src/db/schemas/index.schema';
import { fixtureRepository } from '../../src/repositories/fixtures';
import {
  clearFixturesCache,
  syncAllGameweeks,
  syncFixtures,
} from '../../src/services/fixtures.service';

describe('Fixtures Integration Tests', () => {
  beforeEach(async () => {
    await fixtureRepository.deleteAll();
    await clearFixturesCache();
  });

  test('syncFixtures persists data to database', async () => {
    const result = await syncFixtures();
    expect(result.count).toBeGreaterThan(0);

    const db = await getDb();
    const rows = await db.select({ id: eventFixtures.id }).from(eventFixtures);
    expect(rows.length).toBe(result.count);
  });

  test('clearFixturesCache completes after sync', async () => {
    await syncFixtures();
    await expect(clearFixturesCache()).resolves.toBeUndefined();
  });

  test('syncAllGameweeks returns summary for each event', async () => {
    const summary = await syncAllGameweeks();
    expect(summary.totalCount).toBeGreaterThan(0);
    expect(summary.perGameweek.length).toBeGreaterThan(0);
  });
});
