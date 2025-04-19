import { PrismaClient } from '@prisma/client';
import * as E from 'fp-ts/Either';
// Removed Redis import
import { Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Use the generic setup
import {
  IntegrationTestSetupResult,
  setupIntegrationTest,
  teardownIntegrationTest,
} from '../../setup/integrationTestSetup';

// Import the SHARED redis client used by the application
import { redisClient } from '../../../src/infrastructures/cache/client';

// Specific imports for this test suite
import { CachePrefix } from '../../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../../src/data/fpl/bootstrap.data';
import { FplBootstrapDataService } from '../../../src/data/types';
import { createPlayerStatCache } from '../../../src/domains/player-stat/cache';
import { PlayerStatCache, PlayerStatRepository } from '../../../src/domains/player-stat/types';
import { HTTPClient } from '../../../src/infrastructures/http';
import { createPlayerStatRepository } from '../../../src/repositories/player-stat/repository';
import { createPlayerStatService } from '../../../src/services/player-stat/service';
import { PlayerStatService } from '../../../src/services/player-stat/types';
import { playerStatWorkflows } from '../../../src/services/player-stat/workflow';
// Need Event service dependency for PlayerStatService
import { createEventCache } from '../../../src/domains/event/cache';
import { EventCache, EventRepository } from '../../../src/domains/event/types';
import { createEventRepository } from '../../../src/repositories/event/repository';
import { createEventService } from '../../../src/services/event/service';
import { EventService } from '../../../src/services/event/types';

// Increase timeout for this describe block to 30 seconds
describe('PlayerStat Integration Tests', { timeout: 30000 }, () => {
  let setup: IntegrationTestSetupResult;
  let prisma: PrismaClient;
  // Removed local redis
  let logger: Logger;
  let httpClient: HTTPClient;
  let playerStatRepository: PlayerStatRepository;
  let playerStatCache: PlayerStatCache;
  let fplDataService: FplBootstrapDataService;
  let playerStatService: PlayerStatService;
  // Event service dependencies
  let eventRepository: EventRepository;
  let eventCache: EventCache;
  let eventService: EventService;

  const cachePrefix = CachePrefix.PLAYER_STAT;
  const eventCachePrefix = CachePrefix.EVENT;
  const testSeason = '2425';

  beforeAll(async () => {
    setup = await setupIntegrationTest();
    prisma = setup.prisma;
    // No local redis assignment
    logger = setup.logger;
    httpClient = setup.httpClient;

    // Ping shared client (optional)
    try {
      await redisClient.ping();
    } catch (error) {
      logger.error({ err: error }, 'Shared redisClient ping failed in beforeAll.');
    }

    fplDataService = createFplBootstrapDataService(httpClient, logger);

    eventRepository = createEventRepository(prisma);
    // Event cache uses singleton client
    eventCache = createEventCache(eventRepository, {
      keyPrefix: eventCachePrefix,
      season: testSeason,
    });
    eventService = createEventService(fplDataService, eventRepository, eventCache);

    playerStatRepository = createPlayerStatRepository(prisma);
    // PlayerStat cache uses singleton client
    playerStatCache = createPlayerStatCache(playerStatRepository, {
      keyPrefix: cachePrefix,
      season: testSeason,
    });
    playerStatService = createPlayerStatService(
      fplDataService,
      playerStatRepository,
      playerStatCache,
      eventService,
    );
  });

  beforeEach(async () => {
    await prisma.playerStat.deleteMany({});
    await prisma.event.deleteMany({});

    // Use shared client for cleanup
    const statKeys = await redisClient.keys(`${cachePrefix}::${testSeason}*`);
    if (statKeys.length > 0) {
      await redisClient.del(statKeys);
    }
    const eventKeys = await redisClient.keys(`${eventCachePrefix}::${testSeason}*`);
    if (eventKeys.length > 0) {
      await redisClient.del(eventKeys);
    }
  });

  afterAll(async () => {
    await teardownIntegrationTest(setup);
    // await redisClient.quit(); // If global teardown needed
  });

  describe('PlayerStat Service Integration', () => {
    it('should fetch player stats from API, store in database, and cache them', async () => {
      await eventService.syncEventsFromApi()();

      const syncResult = await playerStatService.syncPlayerStatsFromApi()();

      expect(E.isRight(syncResult)).toBe(true);
      if (E.isRight(syncResult)) {
        const playerStats = syncResult.right;
        expect(playerStats.length).toBeGreaterThan(0);
        const firstStat = playerStats[0];
        expect(firstStat).toHaveProperty('elementId');
        expect(firstStat).toHaveProperty('eventId');
        expect(firstStat).toHaveProperty('minutes');
      }

      const dbStats = await prisma.playerStat.findMany();
      expect(dbStats.length).toBeGreaterThan(0);

      // Use shared client for check
      const keysExist = (await redisClient.keys(`${cachePrefix}::${testSeason}*`)).length > 0;
      expect(keysExist).toBe(true);
    });

    it('should get player stat by ID after syncing', async () => {
      await eventService.syncEventsFromApi()();
      const syncResult = await playerStatService.syncPlayerStatsFromApi()();

      if (E.isRight(syncResult)) {
        const stats = syncResult.right;
        if (stats.length > 0) {
          const firstStatId = stats[0].id;
          const statResult = await playerStatService.getPlayerStat(firstStatId)();

          expect(E.isRight(statResult)).toBe(true);
          if (E.isRight(statResult) && statResult.right) {
            expect(statResult.right.id).toEqual(firstStatId);
          }
        }
      }
    });
  });

  describe('PlayerStat Workflow Integration', () => {
    it('should execute the sync player stats workflow end-to-end', async () => {
      await eventService.syncEventsFromApi()();

      const workflows = playerStatWorkflows(playerStatService);
      const result = await workflows.syncPlayerStats()();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right.context).toBeDefined();
        expect(result.right.duration).toBeGreaterThan(0);
        expect(result.right.result).toBeDefined();
        expect(result.right.result.length).toBeGreaterThan(0);

        const dbStats = await prisma.playerStat.findMany();
        expect(dbStats.length).toEqual(result.right.result.length);
      }
    });
  });
});
