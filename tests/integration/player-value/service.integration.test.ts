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
import { createPlayerValueCache } from '../../../src/domains/player-value/cache';
import { PlayerValueCache, PlayerValueRepository } from '../../../src/domains/player-value/types';
import { HTTPClient } from '../../../src/infrastructures/http';
import { createPlayerValueRepository } from '../../../src/repositories/player-value/repository';
import { createPlayerValueService } from '../../../src/services/player-value/service';
import { PlayerValueService } from '../../../src/services/player-value/types';
import { playerValueWorkflows } from '../../../src/services/player-value/workflow';
// Need Event service dependency
import { createEventCache } from '../../../src/domains/event/cache';
import { EventCache, EventRepository } from '../../../src/domains/event/types';
import { createEventRepository } from '../../../src/repositories/event/repository';
import { createEventService } from '../../../src/services/event/service';
import { EventService } from '../../../src/services/event/types';

describe('PlayerValue Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let prisma: PrismaClient;
  // Removed local redis
  let logger: Logger;
  let httpClient: HTTPClient;
  let playerValueRepository: PlayerValueRepository;
  let playerValueCache: PlayerValueCache;
  let fplDataService: FplBootstrapDataService;
  let playerValueService: PlayerValueService;
  // Event service dependencies
  let eventRepository: EventRepository;
  let eventCache: EventCache;
  let eventService: EventService;

  const cachePrefix = CachePrefix.PLAYER_VALUE;
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

    playerValueRepository = createPlayerValueRepository(prisma);
    // PlayerValue cache uses singleton client
    playerValueCache = createPlayerValueCache(playerValueRepository, {
      keyPrefix: cachePrefix,
      season: testSeason,
    });
    playerValueService = createPlayerValueService(
      fplDataService,
      playerValueRepository,
      playerValueCache,
      eventService,
    );
  });

  beforeEach(async () => {
    await prisma.playerValue.deleteMany({});
    await prisma.event.deleteMany({});

    // Use shared client for cleanup
    const valueKeys = await redisClient.keys(`${cachePrefix}::${testSeason}*`);
    if (valueKeys.length > 0) {
      await redisClient.del(valueKeys);
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

  describe('PlayerValue Service Integration', () => {
    it('should fetch player values from API, store in database, and cache them', async () => {
      await eventService.syncEventsFromApi()();

      const syncResult = await playerValueService.syncPlayerValuesFromApi()();

      expect(E.isRight(syncResult)).toBe(true);
      if (E.isRight(syncResult)) {
        const playerValues = syncResult.right;
        expect(playerValues.length).toBeGreaterThan(0);
        const firstValue = playerValues[0];
        expect(firstValue).toHaveProperty('elementId');
        expect(firstValue).toHaveProperty('eventId');
        expect(firstValue).toHaveProperty('value');
      }

      const dbValues = await prisma.playerValue.findMany();
      expect(dbValues.length).toBeGreaterThan(0);

      // Use shared client for check
      const keysExist = (await redisClient.keys(`${cachePrefix}::${testSeason}*`)).length > 0;
      expect(keysExist).toBe(true);
    });

    it('should get player value by ID after syncing', async () => {
      await eventService.syncEventsFromApi()();
      const syncResult = await playerValueService.syncPlayerValuesFromApi()();

      if (E.isRight(syncResult)) {
        const values = syncResult.right;
        if (values.length > 0) {
          // Make sure values[0] and its id exist before accessing
          const firstValueId = values[0]?.id;
          if (firstValueId === undefined) {
            throw new Error('First player value or its ID is undefined after sync');
          }

          // Attempting to fetch using the ID obtained above
          const valueResult = await playerValueService.getPlayerValue(firstValueId)();

          expect(E.isRight(valueResult)).toBe(true);
          if (E.isRight(valueResult) && valueResult.right) {
            expect(valueResult.right.id).toEqual(firstValueId);
          }
        }
      }
    });
  });

  describe('PlayerValue Workflow Integration', () => {
    it('should execute the sync player values workflow end-to-end', async () => {
      await eventService.syncEventsFromApi()();

      const workflows = playerValueWorkflows(playerValueService);
      const result = await workflows.syncPlayerValues()();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right.context).toBeDefined();
        expect(result.right.duration).toBeGreaterThan(0);
        expect(result.right.result).toBeDefined();
        expect(result.right.result.length).toBeGreaterThan(0);

        const dbValues = await prisma.playerValue.findMany();
        expect(dbValues.length).toEqual(result.right.result.length);
      }
    });
  });
});
