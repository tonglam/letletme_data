import { beforeAll, describe, expect, test } from 'bun:test';

import { playersCache } from '../../src/cache/operations';
import { players } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import { syncPlayers } from '../../src/services/players.service';

describe('Players Integration Tests', () => {
  let syncResult: { count: number; errors: number };

  beforeAll(async () => {
    // Clear cache and sync once
    await playersCache.clear();
    syncResult = await syncPlayers();
  });

  test('syncPlayers persists player data to the database', async () => {
    expect(syncResult.count).toBeGreaterThan(0);
    expect(syncResult.errors).toBeGreaterThanOrEqual(0);

    const db = await getDb();
    const dbPlayers = await db.select().from(players);
    expect(dbPlayers.length).toBeGreaterThan(0);
    expect(dbPlayers.length).toBe(syncResult.count);
  });

  test('should have valid player structure', async () => {
    const db = await getDb();
    const playerRows = await db.select().from(players).limit(1);
    expect(playerRows.length).toBeGreaterThan(0);

    const player = playerRows[0];
    expect(typeof player.id).toBe('number');
    expect(typeof player.code).toBe('number');
    expect(typeof player.type).toBe('number');
    expect(typeof player.teamId).toBe('number');
    expect(typeof player.firstName).toBe('string');
    expect(typeof player.secondName).toBe('string');
    expect(typeof player.webName).toBe('string');
  });

  test('should populate cache after sync', async () => {
    const cachedPlayers = await playersCache.get();
    expect(cachedPlayers).not.toBeNull();
    expect(cachedPlayers!.length).toBe(syncResult.count);
  });

  test('should have players from all teams', async () => {
    const db = await getDb();
    const playerRows = await db.select().from(players);

    const uniqueTeams = new Set(playerRows.map((p) => p.teamId));
    expect(uniqueTeams.size).toBeGreaterThan(15); // Most teams should have players
    expect(uniqueTeams.size).toBeLessThanOrEqual(20); // Max 20 Premier League teams
  });

  test('should have players with all positions', async () => {
    const db = await getDb();
    const playerRows = await db.select().from(players);

    const positions = new Set(playerRows.map((p) => p.type));
    expect(positions.has(1)).toBe(true); // GK
    expect(positions.has(2)).toBe(true); // DEF
    expect(positions.has(3)).toBe(true); // MID
    expect(positions.has(4)).toBe(true); // FWD
  });

  test('playersCache.clear removes cached player data', async () => {
    const cachedBefore = await playersCache.get();
    expect(cachedBefore).not.toBeNull();

    await playersCache.clear();

    const cachedAfter = await playersCache.get();
    expect(cachedAfter).toBeNull();

    // Re-sync for other tests
    await syncPlayers();
  });

  test('should have created_at and updated_at timestamps', async () => {
    const db = await getDb();
    const playerRows = await db.select().from(players).limit(3);

    playerRows.forEach((player) => {
      expect(player.createdAt).toBeDefined();
      expect(player.updatedAt).toBeDefined();
      expect(player.createdAt).toBeInstanceOf(Date);
      expect(player.updatedAt).toBeInstanceOf(Date);
    });
  });

  test('should update updated_at on re-sync', async () => {
    const db = await getDb();

    // Get initial timestamps
    const before = await db.select().from(players).limit(1);
    const beforeUpdatedAt = before[0].updatedAt;

    // Wait a moment to ensure timestamp difference
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Re-sync players
    await syncPlayers();

    // Get new timestamps
    const after = await db.select().from(players).limit(1);
    const afterUpdatedAt = after[0].updatedAt;

    // created_at should remain unchanged, updated_at should change
    expect(after[0].createdAt).toEqual(before[0].createdAt);
    expect(afterUpdatedAt?.getTime()).toBeGreaterThan(beforeUpdatedAt?.getTime() || 0);
  });
});
