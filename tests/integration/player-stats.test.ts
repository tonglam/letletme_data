import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();
import { beforeAll, describe, expect, test } from 'bun:test';

import { count, eq } from 'drizzle-orm';

import { playerStatsCache } from '../../src/cache/operations';
import { playerMarketSnapshots, playerStats } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import {
  syncCurrentPlayerStats,
  syncPlayerStatsForEvent,
} from '../../src/services/player-stats.service';
import { resolvePlayerSyncEvent } from '../../src/services/player-sync-event.service';
import { ensureEvents, ensurePlayers } from './helpers/reference-data';

let syncedEventId: number;
let syncedSnapshotDate: string;
await ensureEvents();
const syncEvent = await resolvePlayerSyncEvent();

describe.skipIf(!syncEvent)('Player Stats Operational Integration', () => {
  beforeAll(async () => {
    await ensurePlayers();
    await playerStatsCache.clearAll();
    const result = await syncCurrentPlayerStats();
    syncedEventId = result.eventId;
    syncedSnapshotDate = result.snapshotDate;
  });

  test('syncCurrentPlayerStats stores one complete idempotent daily market roster', async () => {
    const db = await getDb();
    const [beforeRetry] = await db
      .select({ count: count() })
      .from(playerMarketSnapshots)
      .where(eq(playerMarketSnapshots.snapshotDate, syncedSnapshotDate));

    const retry = await syncCurrentPlayerStats();
    const [afterRetry] = await db
      .select({ count: count() })
      .from(playerMarketSnapshots)
      .where(eq(playerMarketSnapshots.snapshotDate, syncedSnapshotDate));

    expect(beforeRetry.count).toBeGreaterThan(0);
    expect(beforeRetry.count).toBe(retry.marketSnapshotCount);
    expect(afterRetry.count).toBe(beforeRetry.count);
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
