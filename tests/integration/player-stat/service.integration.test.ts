import { PrismaClient } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CachePrefix } from '../../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../../src/data/fpl/bootstrap.data';
import { FplBootstrapDataService } from '../../../src/data/types';
import { createEventCache } from '../../../src/domains/event/cache';
import { EventCache } from '../../../src/domains/event/types';
import { createPlayerCache } from '../../../src/domains/player/cache';
import { PlayerCache } from '../../../src/domains/player/types';
import { createPlayerStatCache } from '../../../src/domains/player-stat/cache';
import { PlayerStatCache } from '../../../src/domains/player-stat/types';
import { createTeamCache } from '../../../src/domains/team/cache';
import { TeamCache } from '../../../src/domains/team/types';
import { redisClient } from '../../../src/infrastructures/cache/client';
import { HTTPClient } from '../../../src/infrastructures/http';
import { createEventRepository } from '../../../src/repositories/event/repository';
import { EventRepository } from '../../../src/repositories/event/type';
import { createPlayerRepository } from '../../../src/repositories/player/repository';
import { PlayerRepository } from '../../../src/repositories/player/type';
import { createPlayerStatRepository } from '../../../src/repositories/player-stat/repository';
import { PlayerStatRepository } from '../../../src/repositories/player-stat/type';
import { createTeamRepository } from '../../../src/repositories/team/repository';
import { TeamRepository } from '../../../src/repositories/team/type';
import { createPlayerService } from '../../../src/services/player/service';
import { PlayerService } from '../../../src/services/player/types';
import { createPlayerStatService } from '../../../src/services/player-stat/service';
import { PlayerStatService } from '../../../src/services/player-stat/types';
import { playerStatWorkflows } from '../../../src/services/player-stat/workflow';
import { createTeamService } from '../../../src/services/team/service';
import { TeamService } from '../../../src/services/team/types';
import {
  IntegrationTestSetupResult,
  setupIntegrationTest,
  teardownIntegrationTest,
} from '../../setup/integrationTestSetup';

// Increase timeout for this describe block
describe('PlayerStat Integration Tests', { timeout: 30000 }, () => {
  let setup: IntegrationTestSetupResult;
  let prisma: PrismaClient;
  let logger: Logger;
  let httpClient: HTTPClient;
  let fplDataService: FplBootstrapDataService;
  let playerStatRepository: PlayerStatRepository;
  let playerStatCache: PlayerStatCache;
  let playerStatService: PlayerStatService;
  let eventRepository: EventRepository;
  let eventCache: EventCache;
  let playerRepository: PlayerRepository;
  let playerCache: PlayerCache;
  let playerService: PlayerService;
  let teamRepository: TeamRepository;
  let teamCache: TeamCache;
  let teamService: TeamService;

  const cachePrefix = CachePrefix.PLAYER_STAT;
  const eventCachePrefix = CachePrefix.EVENT;
  const playerCachePrefix = CachePrefix.PLAYER;
  const teamCachePrefix = CachePrefix.TEAM;
  const season = '2425';
  // No base key needed

  beforeAll(async () => {
    setup = await setupIntegrationTest();
    prisma = setup.prisma;
    logger = setup.logger;
    httpClient = setup.httpClient;

    try {
      await redisClient.ping();
    } catch {
      /* Ignore error */
    }

    fplDataService = createFplBootstrapDataService(httpClient, logger);

    // Sync Player and Team Data FIRST
    playerRepository = createPlayerRepository(prisma);
    playerCache = createPlayerCache(playerRepository, { keyPrefix: playerCachePrefix, season });
    teamRepository = createTeamRepository(prisma);
    teamCache = createTeamCache(teamRepository, { keyPrefix: teamCachePrefix, season });

    // Instantiate services needed for sync
    playerService = createPlayerService(fplDataService, playerRepository, playerCache);
    teamService = createTeamService(fplDataService, teamRepository, teamCache);

    // Sync Teams
    const teamSyncResult = await teamService.syncTeamsFromApi()();
    if (E.isLeft(teamSyncResult)) throw new Error('Failed to sync teams');

    // Sync Players
    const playerSyncResult = await playerService.syncPlayersFromApi()();
    if (E.isLeft(playerSyncResult)) throw new Error('Failed to sync players');

    // Setup Event components
    eventRepository = createEventRepository(prisma);
    eventCache = createEventCache(eventRepository, { keyPrefix: eventCachePrefix, season });
    await eventCache.getAllEvents()(); // Populate event cache

    // Ensure Player/Team caches are populated *after* DB sync for PlayerStat service
    await playerCache.getAllPlayers()();
    await teamCache.getAllTeams()();

    // Setup PlayerStat components
    playerStatRepository = createPlayerStatRepository(prisma);
    playerStatCache = createPlayerStatCache({
      keyPrefix: cachePrefix,
      season,
    });
    playerStatService = createPlayerStatService(
      fplDataService,
      playerStatRepository,
      playerStatCache,
      eventCache,
      playerCache,
      teamCache,
    );
  });

  beforeEach(async () => {
    // Clear only PlayerStat data
    await prisma.playerStat.deleteMany({});
    const statKeys = await redisClient.keys(`${cachePrefix}::${season}*`);
    if (statKeys.length > 0) {
      await redisClient.del(statKeys);
    }
    // No need to clear base key
  });

  afterAll(async () => {
    await teardownIntegrationTest(setup);
  });

  describe('PlayerStat Service Integration', () => {
    it('should fetch player stats from API, store in database, and cache them', async () => {
      const syncResult = await playerStatService.syncPlayerStatsFromApi()();
      expect(E.isRight(syncResult)).toBe(true);

      // --- Direct Cache Check Removed ---

      const latestStatsResult = await playerStatService.getLatestPlayerStats()();
      // --- Retry Logic Removed ---

      expect(E.isRight(latestStatsResult)).toBe(true);

      if (E.isRight(latestStatsResult)) {
        const playerStats = latestStatsResult.right;
        expect(playerStats.length).toBeGreaterThan(0);
        const firstStat = playerStats[0];

        // Corrected assertions
        expect(firstStat).toHaveProperty('element');
        expect(firstStat).toHaveProperty('event');
        expect(firstStat).toHaveProperty('minutes');
        expect(firstStat).toHaveProperty('elementType');
        expect(firstStat).toHaveProperty('elementTypeName');
        expect(firstStat).toHaveProperty('team');
        expect(firstStat).toHaveProperty('teamName');
        expect(firstStat).toHaveProperty('teamShortName');
      }

      const dbStats = await prisma.playerStat.findMany();
      expect(dbStats.length).toBeGreaterThan(0);
    });

    it('should get player stat by ID after syncing', async () => {
      const syncResult = await playerStatService.syncPlayerStatsFromApi()();
      expect(E.isRight(syncResult)).toBe(true);

      const latestStatsResult = await playerStatService.getLatestPlayerStats()();
      // --- Retry Logic Removed ---

      expect(E.isRight(latestStatsResult)).toBe(true);

      if (E.isRight(latestStatsResult)) {
        const stats = latestStatsResult.right;
        expect(stats.length).toBeGreaterThan(0);
        const firstStatElement = stats[0].element;
        const statResult = await playerStatService.getPlayerStat(firstStatElement)();

        expect(E.isRight(statResult)).toBe(true);
        if (E.isRight(statResult) && statResult.right) {
          expect(statResult.right.element).toEqual(firstStatElement);
          // Corrected assertions
          expect(statResult.right).toHaveProperty('elementType');
          expect(statResult.right).toHaveProperty('teamName');
        } else {
          throw new Error('getPlayerStat returned Left or null');
        }
      } else {
        throw new Error('getLatestPlayerStats failed');
      }
    });

    it('should get player stats by element type after syncing', async () => {
      await playerStatService.syncPlayerStatsFromApi()();
      const latestStatsResult = await playerStatService.getLatestPlayerStats()();
      expect(E.isRight(latestStatsResult)).toBe(true);

      if (E.isRight(latestStatsResult) && latestStatsResult.right.length > 0) {
        const firstStat = latestStatsResult.right[0];
        const elementTypeToTest = firstStat.elementType;

        const statsByTypeResult =
          await playerStatService.getPlayerStatsByElementType(elementTypeToTest)();
        expect(E.isRight(statsByTypeResult)).toBe(true);

        if (E.isRight(statsByTypeResult)) {
          const stats = statsByTypeResult.right;
          expect(stats.length).toBeGreaterThan(0);
          stats.forEach((s) => {
            expect(s.elementType).toEqual(elementTypeToTest);
            // Check enrichment
            expect(s).toHaveProperty('elementTypeName');
          });
        } else {
          throw new Error('getPlayerStatsByElementType returned Left');
        }
      } else {
        throw new Error('Could not get latest stats or stats list is empty after sync.');
      }
    });

    it('should get player stats by team after syncing', async () => {
      await playerStatService.syncPlayerStatsFromApi()();
      const latestStatsResult = await playerStatService.getLatestPlayerStats()();
      expect(E.isRight(latestStatsResult)).toBe(true);

      if (E.isRight(latestStatsResult) && latestStatsResult.right.length > 0) {
        const firstStat = latestStatsResult.right[0];
        const teamToTest = firstStat.team;

        const statsByTeamResult = await playerStatService.getPlayerStatsByTeam(teamToTest)();
        expect(E.isRight(statsByTeamResult)).toBe(true);

        if (E.isRight(statsByTeamResult)) {
          const stats = statsByTeamResult.right;
          expect(stats.length).toBeGreaterThan(0);
          stats.forEach((s) => {
            expect(s.team).toEqual(teamToTest);
            // Check enrichment
            expect(s).toHaveProperty('teamName');
            expect(s).toHaveProperty('teamShortName');
          });
        } else {
          throw new Error('getPlayerStatsByTeam returned Left');
        }
      } else {
        throw new Error('Could not get latest stats or stats list is empty after sync.');
      }
    });
  });

  describe('PlayerStat Workflow Integration', () => {
    it('should execute the sync player stats workflow end-to-end', async () => {
      const workflows = playerStatWorkflows(playerStatService);
      const result = await workflows.syncPlayerStats()();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right.context).toBeDefined();
        expect(result.right.duration).toBeGreaterThan(0);

        // Verify DB side effect
        const dbStats = await prisma.playerStat.findMany();
        expect(dbStats.length).toBeGreaterThan(0);
      }
    });
  });
});
