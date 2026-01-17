import { beforeAll, describe, expect, test } from 'bun:test';

import { playersCache } from '../../src/cache/operations';
import { players } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import { playerRepository } from '../../src/repositories/players';
import { syncPlayers } from '../../src/services/players.service';

describe('Players Integration Tests', () => {
  beforeAll(async () => {
    await playersCache.clear();
    await playerRepository.deleteAll();
  });

  test('syncPlayers persists player data to the database and cache', async () => {
    const result = await syncPlayers();
    expect(result.count).toBeGreaterThan(0);
    expect(result.errors).toBeGreaterThanOrEqual(0);

    const db = await getDb();
    const dbPlayers = await db.select().from(players);
    expect(dbPlayers.length).toBeGreaterThan(0);
    expect(dbPlayers[0]).toHaveProperty('id');
    expect(dbPlayers[0]).toHaveProperty('firstName');

    const cachedPlayers = await playersCache.get();
    expect(cachedPlayers).not.toBeNull();
    expect(cachedPlayers!.length).toBe(dbPlayers.length);
  });

  test('playersCache.clear removes cached player data', async () => {
    await syncPlayers();
    const cachedBefore = await playersCache.get();
    expect(cachedBefore).not.toBeNull();

    await playersCache.clear();

    const cachedAfter = await playersCache.get();
    expect(cachedAfter).toBeNull();
  });
});
