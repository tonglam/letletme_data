import { beforeAll, describe, expect, test } from 'bun:test';

import { playersCache } from '../../src/cache/operations';
import { playerRepository } from '../../src/repositories/players';
import {
  clearPlayersCache,
  getPlayer,
  getPlayers,
  getPlayersByTeam,
  syncPlayers,
} from '../../src/services/players.service';

describe('Players Integration Tests', () => {
  beforeAll(async () => {
    // SINGLE setup - one API call for entire test suite
    await clearPlayersCache();
    await playerRepository.deleteAll();
    await syncPlayers(); // ONLY API call in entire test suite - tests: FPL API → DB → Redis
  });

  describe('External Data Integration', () => {
    test('should fetch and sync players from FPL API', async () => {
      const players = await getPlayers();
      expect(players.length).toBeGreaterThan(400); // Premier League has ~500+ players
      expect(players[0]).toHaveProperty('id');
      expect(players[0]).toHaveProperty('firstName');
      expect(players[0]).toHaveProperty('secondName');
      expect(players[0]).toHaveProperty('teamId');
      expect(players[0]).toHaveProperty('type'); // position
    });

    test('should save players to database', async () => {
      const dbPlayers = await playerRepository.findAll();
      expect(dbPlayers.length).toBeGreaterThan(400);
      expect(dbPlayers[0].id).toBeTypeOf('number');
      expect(dbPlayers[0].firstName).toBeTypeOf('string');
      expect(dbPlayers[0].teamId).toBeGreaterThanOrEqual(1);
      expect(dbPlayers[0].teamId).toBeLessThanOrEqual(20);
    });
  });

  describe('Service Layer Integration', () => {
    test('should retrieve player by ID', async () => {
      const player = await getPlayer(1);
      expect(player).toBeDefined();
      expect(player?.id).toBe(1);
      expect(player?.firstName).toBeTypeOf('string');
      expect(player?.secondName).toBeTypeOf('string');
    });

    test('should filter players by team', async () => {
      const teamPlayers = await getPlayersByTeam(1);
      expect(teamPlayers).toBeDefined();
      expect(teamPlayers.length).toBeGreaterThan(0);
      expect(teamPlayers.length).toBeLessThanOrEqual(40); // Each team has max ~35 players
      teamPlayers.forEach((player) => {
        expect(player.teamId).toBe(1);
      });
    });

    test('should get all players from cache', async () => {
      const players = await getPlayers(); // Should hit cache
      expect(players.length).toBeGreaterThan(400);
    });
  });

  describe('Cache Integration', () => {
    test('should populate cache after sync', async () => {
      // Verify cache is populated (this was failing before)
      const cachedPlayers = await playersCache.get();
      expect(cachedPlayers).toBeDefined();
      expect(cachedPlayers).not.toBeNull();
      expect(Array.isArray(cachedPlayers)).toBe(true);
      expect(cachedPlayers!.length).toBeGreaterThan(400);
    });

    test('should use cache for fast retrieval', async () => {
      const players = await getPlayers(); // Should hit cache
      expect(players.length).toBeGreaterThan(400);
    });

    test('should handle database fallback', async () => {
      await clearPlayersCache(); // Clear once to test fallback
      const players = await getPlayers(); // Should fallback to database
      expect(players.length).toBeGreaterThan(400);
    });
  });

  describe('Data Consistency', () => {
    test('should maintain consistent data across layers', async () => {
      const servicePlayers = await getPlayers();
      const dbPlayers = await playerRepository.findAll();

      expect(servicePlayers.length).toBe(dbPlayers.length);
      expect(servicePlayers[0].id).toBe(dbPlayers[0].id);
      expect(servicePlayers[0].firstName).toBe(dbPlayers[0].firstName);
    });

    test('should handle cache-database consistency', async () => {
      // Get players to ensure cache is populated
      const allPlayers = await getPlayers();
      expect(allPlayers.length).toBeGreaterThan(0);

      // Get a player from cache
      const cachedPlayers = await playersCache.get();
      expect(cachedPlayers).toBeDefined();
      expect(cachedPlayers).not.toBeNull();
      expect(cachedPlayers!.length).toBeGreaterThan(0);

      const testPlayer = cachedPlayers![0];

      // Get same player from database
      const dbPlayer = await playerRepository.findById(testPlayer.id);
      expect(dbPlayer).toBeDefined();

      // Verify consistency
      expect(dbPlayer!.id).toBe(testPlayer.id);
      expect(dbPlayer!.firstName).toBe(testPlayer.firstName);
      expect(dbPlayer!.secondName).toBe(testPlayer.secondName);
      expect(dbPlayer!.type).toBe(testPlayer.type);
    });
  });
});
