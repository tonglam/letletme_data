import { beforeAll, describe, expect, test } from 'bun:test';

import { eq } from 'drizzle-orm';

import { playerStatsCache } from '../../src/cache/operations';
import { playerStats } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import {
  syncCurrentPlayerStats,
  syncPlayerStatsForEvent,
} from '../../src/services/player-stats.service';

let syncedEventId: number;

describe('Player Stats Operational Integration', () => {
  beforeAll(async () => {
    await playerStatsCache.clearAll();
    const result = await syncCurrentPlayerStats();
    syncedEventId = result.eventId;
  });

  test('syncCurrentPlayerStats stores event data in DB and cache', async () => {
    const db = await getDb();
    const dbStats = await db
      .select({ elementId: playerStats.elementId })
      .from(playerStats)
      .where(eq(playerStats.eventId, syncedEventId));
    expect(dbStats.length).toBeGreaterThan(0);

    const cachedStats = await playerStatsCache.getByEvent(syncedEventId);
    expect(cachedStats).not.toBeNull();
    expect(cachedStats!.length).toBe(dbStats.length);
  });

  test('syncPlayerStatsForEvent refreshes cache for a specific event', async () => {
    const result = await syncPlayerStatsForEvent(syncedEventId);
    expect(result.count).toBeGreaterThan(0);

    const cachedStats = await playerStatsCache.getByEvent(syncedEventId);
    expect(cachedStats).not.toBeNull();
  });

  test('playerStatsCache.clearByEvent removes cached stats', async () => {
    await playerStatsCache.clearByEvent(syncedEventId);
    const cachedAfterClear = await playerStatsCache.getByEvent(syncedEventId);
    expect(cachedAfterClear).toBeNull();
  });
});
