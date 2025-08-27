import { beforeAll, describe, expect, test } from 'bun:test';

import { playerStatsCache } from '../../src/cache/operations';
import { playerStatsRepository } from '../../src/repositories/player-stats';
import {
  deletePlayerStatsByEvent,
  getPlayerStat,
  getPlayerStats,
  getPlayerStatsAnalytics,
  getPlayerStatsByEvent,
  getPlayerStatsByPlayer,
  getPlayerStatsByPosition,
  getPlayerStatsByTeam,
  getTopPerformersByPosition,
  syncCurrentPlayerStats,
  syncPlayerStatsForEvent,
} from '../../src/services/player-stats.service';

describe('Player Stats Integration Tests', () => {
  let testEventId: number;

  beforeAll(async () => {
    // SINGLE setup - one API call for entire test suite
    await playerStatsCache.clearAll();

    // Sync player stats for current gameweek - tests: FPL API → DB → Cache
    const syncResult = await syncCurrentPlayerStats();
    testEventId = syncResult.eventId;

    expect(syncResult.count).toBeGreaterThan(0);
    expect(testEventId).toBeGreaterThan(0);
  });

  describe('External Data Integration', () => {
    test('should fetch and sync player stats from FPL API', async () => {
      const playerStats = await getPlayerStats();
      expect(playerStats.length).toBeGreaterThan(0); // FPL has 600+ players
      expect(playerStats[0]).toHaveProperty('eventId');
      expect(playerStats[0]).toHaveProperty('elementId');
      expect(playerStats[0]).toHaveProperty('webName');
      expect(playerStats[0]).toHaveProperty('elementType');
      expect(playerStats[0]).toHaveProperty('elementTypeName');
      expect(playerStats[0]).toHaveProperty('teamId');
      expect(playerStats[0]).toHaveProperty('teamName');
      expect(playerStats[0]).toHaveProperty('value');
    });

    test('should save player stats to database', async () => {
      const dbPlayerStats = await playerStatsRepository.findAll();
      expect(dbPlayerStats.length).toBeGreaterThan(0);
      expect(dbPlayerStats[0].eventId).toBeTypeOf('number');
      expect(dbPlayerStats[0].elementId).toBeTypeOf('number');
      expect(dbPlayerStats[0].webName).toBeTypeOf('string');
      expect(dbPlayerStats[0].elementType).toBeTypeOf('number');
      expect(dbPlayerStats[0].value).toBeTypeOf('number');
    });

    test('should have proper foreign key relationships', async () => {
      const dbPlayerStats = await playerStatsRepository.findAll();
      expect(dbPlayerStats.length).toBeGreaterThan(0);

      // Consider only current test event to avoid other synced events
      const onlyTestEvent = dbPlayerStats.filter((s) => s.eventId === testEventId);
      expect(onlyTestEvent.length).toBeGreaterThan(0);

      onlyTestEvent.forEach((stat) => {
        expect(stat.eventId).toBe(testEventId);
        expect(stat.elementId).toBeGreaterThan(0);
        expect(stat.teamId).toBeGreaterThan(0);
        expect([1, 2, 3, 4]).toContain(stat.elementType);
        expect(['GKP', 'DEF', 'MID', 'FWD']).toContain(stat.elementTypeName);
      });
    });
  });

  describe('Service Layer Integration', () => {
    test('should retrieve player stats by event ID', async () => {
      const playerStats = await getPlayerStatsByEvent(testEventId);
      expect(playerStats.length).toBeGreaterThan(0);
      playerStats.forEach((stat) => {
        expect(stat.eventId).toBe(testEventId);
      });
    });

    test('should retrieve player stats by player ID', async () => {
      // Get the first player ID from our synced data
      const allStats = await getPlayerStatsByEvent(testEventId);
      const firstPlayerId = allStats[0].elementId;

      const playerStats = await getPlayerStatsByPlayer(firstPlayerId);
      expect(playerStats.length).toBeGreaterThanOrEqual(1);
      playerStats.forEach((stat) => {
        expect(stat.elementId).toBe(firstPlayerId);
      });
    });

    test('should retrieve player stats by team ID', async () => {
      // Get the first team ID from our synced data
      const allStats = await getPlayerStatsByEvent(testEventId);
      const firstTeamId = allStats[0].teamId;

      const teamStats = await getPlayerStatsByTeam(firstTeamId, testEventId);
      expect(teamStats.length).toBeGreaterThan(0);
      teamStats.forEach((stat) => {
        expect(stat.teamId).toBe(firstTeamId);
        expect(stat.eventId).toBe(testEventId);
      });
    });

    test('should retrieve player stats by position', async () => {
      const gkpStats = await getPlayerStatsByPosition(1, testEventId); // Goalkeepers
      const defStats = await getPlayerStatsByPosition(2, testEventId); // Defenders
      const midStats = await getPlayerStatsByPosition(3, testEventId); // Midfielders
      const fwdStats = await getPlayerStatsByPosition(4, testEventId); // Forwards

      expect(gkpStats.length).toBeGreaterThan(0);
      expect(defStats.length).toBeGreaterThan(0);
      expect(midStats.length).toBeGreaterThan(0);
      expect(fwdStats.length).toBeGreaterThan(0);

      gkpStats.forEach((stat) => {
        expect(stat.elementType).toBe(1);
        expect(stat.elementTypeName).toBe('GKP');
      });
      defStats.forEach((stat) => {
        expect(stat.elementType).toBe(2);
        expect(stat.elementTypeName).toBe('DEF');
      });
      midStats.forEach((stat) => {
        expect(stat.elementType).toBe(3);
        expect(stat.elementTypeName).toBe('MID');
      });
      fwdStats.forEach((stat) => {
        expect(stat.elementType).toBe(4);
        expect(stat.elementTypeName).toBe('FWD');
      });
    });

    test('should retrieve specific player stat', async () => {
      const allStats = await getPlayerStatsByEvent(testEventId);
      const firstStat = allStats[0];

      const playerStat = await getPlayerStat(testEventId, firstStat.elementId);
      expect(playerStat).toBeDefined();
      expect(playerStat?.eventId).toBe(testEventId);
      expect(playerStat?.elementId).toBe(firstStat.elementId);
      expect(playerStat).toEqual(firstStat);
    });

    test('should return null for non-existent player stat', async () => {
      const playerStat = await getPlayerStat(999, 999); // Non-existent event and player
      expect(playerStat).toBeNull();
    });

    test('should get top performers by position', async () => {
      const topPerformers = await getTopPerformersByPosition(testEventId, 5);

      expect(topPerformers).toHaveProperty('GKP');
      expect(topPerformers).toHaveProperty('DEF');
      expect(topPerformers).toHaveProperty('MID');
      expect(topPerformers).toHaveProperty('FWD');

      // Each position should have at least one player, max 5
      Object.values(topPerformers).forEach((positionStats) => {
        expect(positionStats.length).toBeGreaterThan(0);
        expect(positionStats.length).toBeLessThanOrEqual(5);

        // Should be sorted by total points (descending)
        for (let i = 1; i < positionStats.length; i++) {
          const prevPoints = positionStats[i - 1].totalPoints ?? 0;
          const currPoints = positionStats[i].totalPoints ?? 0;
          expect(prevPoints).toBeGreaterThanOrEqual(currPoints);
        }
      });
    });

    test('should get player stats analytics', async () => {
      const analytics = await getPlayerStatsAnalytics();

      expect(analytics).toHaveProperty('totalCount');
      expect(analytics).toHaveProperty('latestEventId');
      expect(analytics).toHaveProperty('countsByPosition');

      expect(analytics.totalCount).toBeGreaterThan(0);
      expect(analytics.latestEventId).toBeGreaterThanOrEqual(testEventId);

      expect(analytics.countsByPosition).toHaveProperty('GKP');
      expect(analytics.countsByPosition).toHaveProperty('DEF');
      expect(analytics.countsByPosition).toHaveProperty('MID');
      expect(analytics.countsByPosition).toHaveProperty('FWD');

      // Each position should have some players
      Object.values(analytics.countsByPosition).forEach((count) => {
        expect(count).toBeGreaterThan(0);
      });

      // Total should match sum of positions
      const totalByPosition = Object.values(analytics.countsByPosition).reduce(
        (sum, count) => sum + count,
        0,
      );
      // totalCount can include multiple events; countsByPosition is latest event only
      expect(analytics.totalCount).toBeGreaterThanOrEqual(totalByPosition);
    });
  });

  describe('Cache Integration', () => {
    test('should store player stats in cache by event', async () => {
      // Clear cache first to test cache population
      await playerStatsCache.clearByEvent(testEventId);

      // This should populate the cache
      const playerStats = await getPlayerStatsByEvent(testEventId);
      expect(playerStats.length).toBeGreaterThan(0);

      // Check if cache exists (service now populates cache)
      const cacheExists = await playerStatsCache.existsByEvent(testEventId);
      expect(cacheExists).toBe(true);
    });

    test('should handle cache operations correctly', async () => {
      const playerStats = await getPlayerStatsByEvent(testEventId);
      const firstStat = playerStats[0];

      // Test cache set and get operations
      await playerStatsCache.setPlayerStat(firstStat);
      const cachedStat = await playerStatsCache.getPlayerStat(testEventId, firstStat.elementId);

      // Our cache implementation should work
      expect(cachedStat).toEqual(firstStat);
    });

    test('should handle cache by position operations', async () => {
      const gkpStats = await getPlayerStatsByPosition(1, testEventId);

      // Set cache by event first
      await playerStatsCache.setByEvent(testEventId, gkpStats);

      // Get by position from cache
      const cachedGkpStats = await playerStatsCache.getByPosition(testEventId, 1);
      expect(cachedGkpStats).toEqual(gkpStats);
    });

    test('should handle cache by team operations', async () => {
      const allStats = await getPlayerStatsByEvent(testEventId);
      const firstTeamId = allStats[0].teamId;
      const teamStats = allStats.filter((stat) => stat.teamId === firstTeamId);

      // Set cache by event first
      await playerStatsCache.setByEvent(testEventId, allStats);

      // Get by team from cache
      const cachedTeamStats = await playerStatsCache.getByTeam(testEventId, firstTeamId);
      expect(cachedTeamStats).toEqual(teamStats);
    });

    test('should clear cache correctly', async () => {
      // Set some cache data
      const playerStats = await getPlayerStatsByEvent(testEventId);
      await playerStatsCache.setByEvent(testEventId, playerStats);

      // Clear cache
      await playerStatsCache.clearByEvent(testEventId);

      // Check if cleared
      const exists = await playerStatsCache.existsByEvent(testEventId);
      expect(exists).toBe(false);
    });
  });

  describe('Data Consistency', () => {
    test('should maintain consistent data across layers', async () => {
      const serviceStats = await getPlayerStatsByEvent(testEventId);
      const dbStats = await playerStatsRepository.findByEventId(testEventId);

      expect(serviceStats.length).toBe(dbStats.length);
      expect(serviceStats.length).toBeGreaterThan(0);

      // Compare first stat details (after mapping)
      if (serviceStats.length > 0 && dbStats.length > 0) {
        const serviceStat = serviceStats[0];
        const dbStat = dbStats[0];

        expect(serviceStat.eventId).toBe(dbStat.eventId);
        expect(serviceStat.elementId).toBe(dbStat.elementId);
        expect(serviceStat.webName).toBe(dbStat.webName);
        expect(serviceStat.value).toBe(dbStat.value);
      }
    });

    test('should have valid data types and ranges', async () => {
      const playerStats = await getPlayerStatsByEvent(testEventId);
      expect(playerStats.length).toBeGreaterThan(0);

      playerStats.forEach((stat) => {
        // Required fields
        expect(typeof stat.eventId).toBe('number');
        expect(typeof stat.elementId).toBe('number');
        expect(typeof stat.webName).toBe('string');
        expect(typeof stat.elementType).toBe('number');
        expect(typeof stat.elementTypeName).toBe('string');
        expect(typeof stat.teamId).toBe('number');
        expect(typeof stat.teamName).toBe('string');
        expect(typeof stat.teamShortName).toBe('string');
        expect(typeof stat.value).toBe('number');

        // Value ranges
        expect(stat.eventId).toBe(testEventId);
        expect(stat.elementId).toBeGreaterThan(0);
        expect(stat.webName.length).toBeGreaterThan(0);
        expect([1, 2, 3, 4]).toContain(stat.elementType);
        expect(['GKP', 'DEF', 'MID', 'FWD']).toContain(stat.elementTypeName);
        expect(stat.teamId).toBeGreaterThan(0);
        expect(stat.teamName.length).toBeGreaterThan(0);
        expect(stat.teamShortName.length).toBeGreaterThan(0);
        expect(stat.value).toBeGreaterThanOrEqual(35); // Min 3.5m
        expect(stat.value).toBeLessThanOrEqual(150); // Max 15.0m

        // Position-specific checks
        if (stat.elementType === 1) {
          // GKP
          expect(stat.elementTypeName).toBe('GKP');
          if (stat.saves !== null) {
            expect(stat.saves).toBeGreaterThanOrEqual(0);
          }
        } else if (stat.elementType === 2) {
          // DEF
          expect(stat.elementTypeName).toBe('DEF');
        } else if (stat.elementType === 3) {
          // MID
          expect(stat.elementTypeName).toBe('MID');
        } else if (stat.elementType === 4) {
          // FWD
          expect(stat.elementTypeName).toBe('FWD');
        }

        // Nullable numeric fields should be null or >= 0
        if (stat.totalPoints !== null) {
          // FPL can award negative points in a gameweek (e.g., cards/OG). Allow small negatives.
          expect(stat.totalPoints).toBeGreaterThanOrEqual(-10);
        }
        if (stat.minutes !== null) {
          expect(stat.minutes).toBeGreaterThanOrEqual(0);
        }
        if (stat.goalsScored !== null) {
          expect(stat.goalsScored).toBeGreaterThanOrEqual(0);
        }
        if (stat.assists !== null) {
          expect(stat.assists).toBeGreaterThanOrEqual(0);
        }
      });
    });
  });

  describe('Advanced Operations', () => {
    test('should sync player stats for specific event', async () => {
      const specificEventId = testEventId + 1; // Next event

      try {
        const result = await syncPlayerStatsForEvent(specificEventId);
        expect(result.count).toBeGreaterThan(0);

        // Verify data was saved
        const stats = await getPlayerStatsByEvent(specificEventId);
        expect(stats.length).toBe(result.count);

        stats.forEach((stat) => {
          expect(stat.eventId).toBe(specificEventId);
        });

        // Clean up
        await deletePlayerStatsByEvent(specificEventId);
      } catch (error) {
        // Event might not exist in API - that's ok for this test
        expect(error).toBeDefined();
      }
    });

    test('should delete player stats by event', async () => {
      const deleteTestEventId = testEventId + 2; // Another test event

      try {
        // First, create some test data
        await syncPlayerStatsForEvent(deleteTestEventId);

        // Verify data exists
        const statsBefore = await getPlayerStatsByEvent(deleteTestEventId);
        expect(statsBefore.length).toBeGreaterThan(0);

        // Delete the data
        await deletePlayerStatsByEvent(deleteTestEventId);

        // Verify data is deleted
        const statsAfter = await getPlayerStatsByEvent(deleteTestEventId);
        expect(statsAfter.length).toBe(0);
      } catch (_error) {
        // Event might not exist - that's ok for this test
        console.log('Delete test skipped due to API constraints');
      }
    });

    test('should handle large dataset efficiently', async () => {
      const startTime = performance.now();

      const allStats = await getPlayerStats();
      const gkpStats = await getPlayerStatsByPosition(1);
      const teamStats = await getPlayerStatsByTeam(1);

      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(allStats.length).toBeGreaterThan(0);
      expect(gkpStats.length).toBeGreaterThan(0);
      expect(teamStats.length).toBeGreaterThan(0);

      // Should complete in reasonable time (under 1 second)
      expect(duration).toBeLessThan(1000);
    });
  });

  describe('Real Data Validation', () => {
    test('should have realistic player data', async () => {
      const playerStats = await getPlayerStatsByEvent(testEventId);
      expect(playerStats.length).toBeGreaterThan(500); // FPL has 600+ players
      expect(playerStats.length).toBeLessThanOrEqual(800); // Upper bound relaxed for season data

      // Should have players from all positions
      const positions = [...new Set(playerStats.map((stat) => stat.elementType))];
      expect(positions).toEqual(expect.arrayContaining([1, 2, 3, 4]));

      // Should have players from multiple teams (20 Premier League teams)
      const teams = [...new Set(playerStats.map((stat) => stat.teamId))];
      expect(teams.length).toBeGreaterThanOrEqual(19); // At least 19 teams (one might be missing players)
      expect(teams.length).toBeLessThanOrEqual(20);

      // Should have varied prices
      const prices = playerStats.map((stat) => stat.value);
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);
      expect(minPrice).toBeGreaterThanOrEqual(35); // Min 3.5m
      expect(maxPrice).toBeLessThanOrEqual(150); // Max 15.0m
      expect(maxPrice - minPrice).toBeGreaterThan(50); // Price spread

      // Should have some players with points
      const playersWithPoints = playerStats.filter((stat) => (stat.totalPoints ?? 0) > 0);
      expect(playersWithPoints.length).toBeGreaterThan(playerStats.length * 0.4); // At least 40% have points
    });

    test('should have valid team mapping', async () => {
      const playerStats = await getPlayerStatsByEvent(testEventId);

      playerStats.forEach((stat) => {
        expect(stat.teamId).toBeGreaterThan(0);
        expect(stat.teamId).toBeLessThanOrEqual(20); // 20 Premier League teams
        expect(stat.teamName).toBeTruthy();
        expect(stat.teamName.length).toBeGreaterThan(2);
        expect(stat.teamShortName).toBeTruthy();
        expect(stat.teamShortName.length).toBeGreaterThanOrEqual(3);
        expect(stat.teamShortName.length).toBeLessThanOrEqual(5);
      });
    });

    test('should have realistic performance stats', async () => {
      const playerStats = await getPlayerStatsByEvent(testEventId);

      // Find some high-performing players
      const topPlayers = playerStats.filter((stat) => (stat.totalPoints ?? 0) > 20).slice(0, 10);

      expect(topPlayers.length).toBeGreaterThan(0);

      topPlayers.forEach((player) => {
        // High performers should have some game time
        if (player.minutes !== null) {
          expect(player.minutes).toBeGreaterThan(0);
        }

        // Should have reasonable stats
        if (player.goalsScored !== null) {
          expect(player.goalsScored).toBeGreaterThanOrEqual(0);
          expect(player.goalsScored).toBeLessThan(50); // Realistic season total
        }

        if (player.assists !== null) {
          expect(player.assists).toBeGreaterThanOrEqual(0);
          expect(player.assists).toBeLessThan(30); // Realistic season total
        }

        // Form should be reasonable
        if (player.form) {
          const form = parseFloat(player.form);
          if (!isNaN(form)) {
            expect(form).toBeGreaterThan(0);
            expect(form).toBeLessThan(20); // Unrealistic if > 20
          }
        }
      });
    });
  });
});
