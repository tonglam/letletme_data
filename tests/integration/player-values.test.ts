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
    await playerValuesCache.clearByDate(changeDate);
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

    const cached = await playerValuesCache.getByDate(changeDate);
    if (result.count > 0) {
      expect(cached).not.toBeNull();
      expect(cached!.length).toBe(dbValues.length);
    }
  }, 30000);

  test('playerValuesCache.clearByDate removes cached data', async () => {
    await playerValuesCache.clearByDate(changeDate);
    const cached = await playerValuesCache.getByDate(changeDate);
    expect(cached).toBeNull();
  });
});
