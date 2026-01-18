import { beforeAll, describe, expect, test } from 'bun:test';

import { eq } from 'drizzle-orm';

import { playerValuesCache } from '../../src/cache/operations';
import { playerValues } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import { syncCurrentPlayerValues } from '../../src/services/player-values.service';

const todayDate = () => new Date().toISOString().split('T')[0].replace(/-/g, '');

let changeDate: string;

describe('Player Values Operational Integration', () => {
  beforeAll(async () => {
    changeDate = todayDate();
    await playerValuesCache.clear(changeDate);
    const db = await getDb();
    await db.delete(playerValues).where(eq(playerValues.changeDate, changeDate));
  });

  test('syncCurrentPlayerValues inserts records and populates cache', async () => {
    const result = await syncCurrentPlayerValues();

    const db = await getDb();
    const dbValues = await db
      .select({ elementId: playerValues.elementId })
      .from(playerValues)
      .where(eq(playerValues.changeDate, changeDate));

    expect(dbValues.length).toBeGreaterThanOrEqual(result.count);

    const cached = await playerValuesCache.get(changeDate);
    if (result.count > 0) {
      // Cache should only contain players that changed on this date
      expect(cached).not.toBeNull();
      expect(cached!.length).toBe(result.count);
      expect(cached!.length).toBe(dbValues.length);
      
      // Verify cache matches database
      const cachedElementIds = new Set(cached!.map((v) => v.elementId));
      const dbElementIds = new Set(dbValues.map((v) => v.elementId));
      expect(cachedElementIds.size).toBe(dbElementIds.size);
      for (const elementId of cachedElementIds) {
        expect(dbElementIds.has(elementId)).toBe(true);
      }
    } else {
      // If no changes, cache should be empty or null
      expect(cached === null || cached!.length === 0).toBe(true);
    }
  }, 30000);

  test('playerValuesCache.clear removes cached data', async () => {
    await playerValuesCache.clear(changeDate);
    const cached = await playerValuesCache.get(changeDate);
    expect(cached).toBeNull();
  });
});
