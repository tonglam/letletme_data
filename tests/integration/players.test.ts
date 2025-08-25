/* eslint-disable no-console */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { syncPlayers } from '../../src/api/players';
import { playersCache } from '../../src/cache/operations';
import { fplClient } from '../../src/clients/fpl';
import {
  filterPlayersByPosition,
  getPlayerPosition,
  getPriceChange,
  validatePlayer,
  validateRawFPLElement,
} from '../../src/domain/players';
import { playerRepository } from '../../src/repositories/players';
import { transformPlayer, transformPlayers } from '../../src/transformers/players';

describe('Players Integration Tests - Complete Workflow', () => {
  // Environment check flags
  let hasWorkingDatabase = false;
  let hasWorkingRedis = false;

  beforeAll(async () => {
    // Test database connection
    try {
      const { db } = await import('../../src/db/config');
      await db.execute('SELECT 1;');
      hasWorkingDatabase = true;
      console.log('✅ Database connection available');
    } catch (error) {
      console.log(
        '⚠️ Database not available, will test without DB:',
        (error as Error).message.slice(0, 100),
      );
    }

    // Test Redis connection
    try {
      const { redis: testRedis } = await import('../../src/cache/config');
      await testRedis.ping();
      hasWorkingRedis = true;
      console.log('✅ Redis connection available');
    } catch (error) {
      console.log(
        '⚠️ Redis not available, will test without cache:',
        (error as Error).message.slice(0, 100),
      );
    }

    console.log(`🧪 Test environment: DB=${hasWorkingDatabase}, Redis=${hasWorkingRedis}`);
  });

  describe('FPL API Integration', () => {
    test('should fetch real FPL bootstrap data with players successfully', async () => {
      const bootstrapData = await fplClient.getBootstrap();

      // Verify we get real Premier League data with players
      expect(bootstrapData).toBeDefined();
      expect(bootstrapData.elements).toBeDefined();
      expect(Array.isArray(bootstrapData.elements)).toBe(true);
      expect(bootstrapData.elements.length).toBeGreaterThan(400); // ~600+ players expected

      // Check a few players have expected structure
      const samplePlayers = bootstrapData.elements.slice(0, 5);
      for (const player of samplePlayers) {
        expect(player.id).toBeTypeOf('number');
        expect(player.first_name).toBeTypeOf('string');
        expect(player.second_name).toBeTypeOf('string');
        expect(player.web_name).toBeTypeOf('string');
        expect(player.element_type).toBeGreaterThanOrEqual(1);
        expect(player.element_type).toBeLessThanOrEqual(4);
        expect(player.team).toBeGreaterThanOrEqual(1);
        expect(player.team).toBeLessThanOrEqual(20);
        expect(player.now_cost).toBeGreaterThan(30); // Min 3.5m
        expect(player.code).toBeTypeOf('number');
      }

      console.log(`✅ Fetched ${bootstrapData.elements.length} players from real FPL API`);
    });

    test('should validate real FPL player data using our schemas', async () => {
      const bootstrapData = await fplClient.getBootstrap();
      const samplePlayers = bootstrapData.elements.slice(0, 10);

      for (const rawPlayer of samplePlayers) {
        // Should validate without throwing
        const validatedRawPlayer = validateRawFPLElement(rawPlayer);
        expect(validatedRawPlayer.id).toBe(rawPlayer.id);
        expect(validatedRawPlayer.first_name).toBe(rawPlayer.first_name);
        expect(validatedRawPlayer.second_name).toBe(rawPlayer.second_name);

        // Transform and validate domain player
        const transformedPlayer = transformPlayer(rawPlayer);
        const validatedPlayer = validatePlayer(transformedPlayer);
        expect(validatedPlayer.id).toBe(rawPlayer.id);
        expect(validatedPlayer.type).toBe(rawPlayer.element_type);
        expect(validatedPlayer.teamId).toBe(rawPlayer.team);
      }

      console.log(`✅ Successfully validated ${samplePlayers.length} real FPL players`);
    });
  });

  describe('Player Domain Logic', () => {
    test('should correctly identify player positions', async () => {
      const bootstrapData = await fplClient.getBootstrap();
      const players = bootstrapData.elements.slice(0, 20);

      const positionCounts = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };

      for (const player of players) {
        const position = getPlayerPosition(player.element_type);
        expect(['GKP', 'DEF', 'MID', 'FWD']).toContain(position);
        positionCounts[position]++;
      }

      console.log('✅ Position distribution in sample:', positionCounts);
    });

    test('should calculate price changes correctly', async () => {
      const bootstrapData = await fplClient.getBootstrap();
      const players = transformPlayers(bootstrapData.elements.slice(0, 50));

      for (const player of players) {
        const priceChange = getPriceChange(player);
        expect(typeof priceChange).toBe('number');

        // Price change should be reasonable (between -50 and +50, i.e., -5.0m to +5.0m)
        expect(priceChange).toBeGreaterThanOrEqual(-50);
        expect(priceChange).toBeLessThanOrEqual(50);
      }

      const playersWithChanges = players.filter((p) => getPriceChange(p) !== 0);
      console.log(`✅ Found ${playersWithChanges.length} players with price changes`);
    });

    test('should filter players by position correctly', async () => {
      const bootstrapData = await fplClient.getBootstrap();
      const allPlayers = transformPlayers(bootstrapData.elements);

      // Test each position
      const positions = ['GKP', 'DEF', 'MID', 'FWD'] as const;

      for (const position of positions) {
        const filtered = filterPlayersByPosition(allPlayers, position);

        // All filtered players should have the correct position
        for (const player of filtered) {
          expect(getPlayerPosition(player.type)).toBe(position);
        }

        expect(filtered.length).toBeGreaterThan(0);
        console.log(`✅ ${position}: ${filtered.length} players`);
      }
    });
  });

  describe('Data Transformation', () => {
    test('should transform FPL players to domain models correctly', async () => {
      const bootstrapData = await fplClient.getBootstrap();
      const rawPlayers = bootstrapData.elements.slice(0, 20);

      const transformedPlayers = transformPlayers(rawPlayers);

      expect(transformedPlayers).toHaveLength(rawPlayers.length);

      for (let i = 0; i < transformedPlayers.length; i++) {
        const raw = rawPlayers[i];
        const transformed = transformedPlayers[i];

        expect(transformed.id).toBe(raw.id);
        expect(transformed.code).toBe(raw.code);
        expect(transformed.type).toBe(raw.element_type);
        expect(transformed.teamId).toBe(raw.team);
        expect(transformed.price).toBe(raw.now_cost);
        expect(transformed.startPrice).toBe(raw.now_cost - raw.cost_change_start);
        expect(transformed.firstName).toBe(raw.first_name);
        expect(transformed.secondName).toBe(raw.second_name);
        expect(transformed.webName).toBe(raw.web_name);
      }

      console.log(`✅ Successfully transformed ${transformedPlayers.length} players`);
    });

    test('should handle player transformation errors gracefully', async () => {
      const invalidPlayers = [
        { id: 'invalid' }, // Invalid ID type
        { id: 1, element_type: 5 }, // Invalid position
        { id: 2, now_cost: -10 }, // Invalid price
        null,
        undefined,
      ];

      // transformPlayers should filter out invalid items and continue
      const result = transformPlayers(invalidPlayers);

      // Should get empty array since all items are invalid
      expect(result).toHaveLength(0);

      console.log('✅ Gracefully handled invalid player data');
    });
  });

  describe('Database Integration', () => {
    test.skipIf(!hasWorkingDatabase)('should save and retrieve players from database', async () => {
      // Get real data
      const bootstrapData = await fplClient.getBootstrap();
      const samplePlayers = transformPlayers(bootstrapData.elements.slice(0, 5));

      // Save to database
      const savedPlayers = await playerRepository.upsertBatch(samplePlayers);
      expect(savedPlayers).toHaveLength(samplePlayers.length);

      // Retrieve by ID
      for (const savedPlayer of savedPlayers) {
        const retrieved = await playerRepository.findById(savedPlayer.id);
        expect(retrieved).toBeDefined();
        expect(retrieved!.id).toBe(savedPlayer.id);
        expect(retrieved!.firstName).toBe(savedPlayer.firstName);
        expect(retrieved!.secondName).toBe(savedPlayer.secondName);
      }

      // Test team-based retrieval
      const firstPlayer = savedPlayers[0];
      const teamPlayers = await playerRepository.findByTeam(firstPlayer.teamId);
      expect(teamPlayers.length).toBeGreaterThan(0);
      expect(teamPlayers.some((p) => p.id === firstPlayer.id)).toBe(true);

      console.log(`✅ Successfully saved and retrieved ${savedPlayers.length} players`);
    });

    test.skipIf(!hasWorkingDatabase)('should handle player updates correctly', async () => {
      const bootstrapData = await fplClient.getBootstrap();
      const player = transformPlayers(bootstrapData.elements.slice(0, 1))[0];

      // Initial save
      const saved = await playerRepository.upsert(player);
      expect(saved.price).toBe(player.price);

      // Update price
      const updatedPlayer = { ...player, price: player.price + 5 };
      const updated = await playerRepository.upsert(updatedPlayer);

      expect(updated.id).toBe(player.id);
      expect(updated.price).toBe(player.price + 5);
      expect(updated.updatedAt).not.toBe(saved.updatedAt);

      console.log('✅ Successfully handled player update');
    });
  });

  describe('Redis Cache Integration', () => {
    test.skipIf(!hasWorkingRedis)(
      'should store and retrieve players using Redis hash',
      async () => {
        // Clear cache first
        await playersCache.clear();

        const bootstrapData = await fplClient.getBootstrap();
        const testPlayers = transformPlayers(bootstrapData.elements.slice(0, 10));

        // Store in cache
        await playersCache.set(testPlayers);

        // Retrieve all
        const cachedPlayers = await playersCache.get();
        expect(cachedPlayers).toBeDefined();
        expect(cachedPlayers!).toHaveLength(testPlayers.length);

        // Test individual player retrieval
        const firstPlayer = testPlayers[0];
        const cachedPlayer = await playersCache.getPlayer(firstPlayer.id);
        expect(cachedPlayer).toBeDefined();
        if (cachedPlayer) {
          expect(cachedPlayer.id).toBe(firstPlayer.id);
          expect(cachedPlayer.firstName).toBe(firstPlayer.firstName);
        }

        // Test team-based filtering
        const teamPlayers = await playersCache.getPlayersByTeam(firstPlayer.teamId);
        expect(teamPlayers).toBeDefined();
        expect(teamPlayers!.length).toBeGreaterThan(0);
        expect(teamPlayers!.every((p) => p.teamId === firstPlayer.teamId)).toBe(true);

        // Test position-based filtering
        const positionPlayers = await playersCache.getPlayersByPosition(firstPlayer.type);
        expect(positionPlayers).toBeDefined();
        expect(positionPlayers!.length).toBeGreaterThan(0);
        expect(positionPlayers!.every((p) => p.type === firstPlayer.type)).toBe(true);

        // No metadata needed - Player:2526 contains only the hash data

        console.log(`✅ Redis hash operations successful for ${testPlayers.length} players`);
      },
    );

    test.skipIf(!hasWorkingRedis)('should handle cache miss gracefully', async () => {
      await playersCache.clear();

      const cachedPlayers = await playersCache.get();
      expect(cachedPlayers).toBeNull();

      const nonExistentPlayer = await playersCache.getPlayer(999999);
      expect(nonExistentPlayer).toBeNull();

      const teamPlayers = await playersCache.getPlayersByTeam(999);
      expect(teamPlayers).toBeNull();

      console.log('✅ Cache miss handling working correctly');
    });
  });

  describe('Full Integration Workflow', () => {
    test.skipIf(!hasWorkingDatabase || !hasWorkingRedis)(
      'should complete full sync workflow',
      async () => {
        console.log('🚀 Starting full players sync workflow...');

        // Clear cache to start fresh
        await playersCache.clear();

        // Run the full sync (this tests the entire chain)
        const result = await syncPlayers();

        expect(result.count).toBeGreaterThan(400); // Should get 600+ players
        expect(result.errors).toBeDefined();

        // Verify database has data
        const dbPlayers = await playerRepository.findAll();
        expect(dbPlayers.length).toBeGreaterThanOrEqual(result.count);

        // Verify cache has data
        const cachedPlayers = await playersCache.get();
        expect(cachedPlayers).toBeDefined();
        expect(cachedPlayers!.length).toBe(result.count);

        // Test a few random players across different teams and positions
        const sampleIndices = [0, 50, 100, 200, 300];
        for (const index of sampleIndices) {
          if (index < cachedPlayers!.length) {
            const player = cachedPlayers![index];

            // Verify data integrity
            expect(player.id).toBeTypeOf('number');
            expect(player.firstName).toBeTypeOf('string');
            expect(player.secondName).toBeTypeOf('string');
            expect(['GKP', 'DEF', 'MID', 'FWD']).toContain(getPlayerPosition(player.type));
            expect(player.teamId).toBeGreaterThanOrEqual(1);
            expect(player.teamId).toBeLessThanOrEqual(20);

            // Test individual cache retrieval
            const individualPlayer = await playersCache.getPlayer(player.id);
            expect(individualPlayer).toBeDefined();
            if (individualPlayer) {
              expect(individualPlayer.id).toBe(player.id);
            }
          }
        }

        // Test position filtering
        const gkps = await playersCache.getPlayersByPosition(1);
        const defs = await playersCache.getPlayersByPosition(2);
        const mids = await playersCache.getPlayersByPosition(3);
        const fwds = await playersCache.getPlayersByPosition(4);

        expect(gkps!.length).toBeGreaterThan(30); // ~40 GKPs expected
        expect(defs!.length).toBeGreaterThan(150); // ~200 DEFs expected
        expect(mids!.length).toBeGreaterThan(200); // ~250 MIDs expected
        expect(fwds!.length).toBeGreaterThan(70); // ~75 FWDs expected

        console.log(`✅ Full sync completed: ${result.count} players, ${result.errors} errors`);
        console.log(
          `📊 Position breakdown: GKP=${gkps!.length}, DEF=${defs!.length}, MID=${mids!.length}, FWD=${fwds!.length}`,
        );
      },
    );

    test.skipIf(!hasWorkingDatabase || !hasWorkingRedis)(
      'should handle cache-database consistency',
      async () => {
        // Get a player from cache
        const cachedPlayers = await playersCache.get();
        expect(cachedPlayers).toBeDefined();
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
        expect(dbPlayer!.teamId).toBe(testPlayer.teamId);
        expect(dbPlayer!.price).toBe(testPlayer.price);

        console.log(`✅ Cache-database consistency verified for player ${testPlayer.id}`);
      },
    );
  });

  afterAll(async () => {
    // Clean up test data if needed
    if (hasWorkingRedis) {
      try {
        await playersCache.clear();
        console.log('🧹 Cleaned up Redis test data');
      } catch (error) {
        console.log('⚠️ Redis cleanup warning:', (error as Error).message);
      }
    }

    console.log('🏁 Players integration tests completed');
  });
});
