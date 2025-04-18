import { PrismaClient } from '@prisma/client';
import * as E from 'fp-ts/Either';
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
import { createFplBootstrapDataService } from '../../../src/data/fpl/fetches/bootstrap/bootstrap.data';
import { FplBootstrapDataService } from '../../../src/data/types';
import { createEventCache } from '../../../src/domains/event/cache';
import { EventCache, EventRepository } from '../../../src/domains/event/types';
import { HTTPClient } from '../../../src/infrastructures/http/client';
import { createEventRepository } from '../../../src/repositories/event/repository';
import { createEventService } from '../../../src/services/event/service';
import { EventService } from '../../../src/services/event/types';
import { eventWorkflows } from '../../../src/services/event/workflow';

describe('Event Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let prisma: PrismaClient;
  let logger: Logger;
  let httpClient: HTTPClient;
  let eventRepository: EventRepository;
  let eventCache: EventCache;
  let fplDataService: FplBootstrapDataService;
  let eventService: EventService;

  const cachePrefix = CachePrefix.EVENT;
  const testSeason = '2425';

  beforeAll(async () => {
    // Get generic resources
    setup = await setupIntegrationTest();
    prisma = setup.prisma;
    logger = setup.logger;
    httpClient = setup.httpClient;

    // Ping the shared client to ensure connection (optional but recommended)
    try {
      await redisClient.ping();
    } catch (error) {
      logger.error(
        { err: error },
        'Shared redisClient ping failed in beforeAll. Ensure it is connected globally.',
      );
    }

    // Instantiate specific dependencies
    eventRepository = createEventRepository(prisma);
    // createEventCache uses the imported singleton redisClient internally
    eventCache = createEventCache(eventRepository, {
      keyPrefix: cachePrefix,
      season: testSeason,
    });
    fplDataService = createFplBootstrapDataService(httpClient, logger);
    eventService = createEventService(fplDataService, eventRepository, eventCache);
  });

  beforeEach(async () => {
    await prisma.event.deleteMany({});
    // Use the imported singleton redisClient to clear keys
    const keys = await redisClient.keys(`${cachePrefix}::${testSeason}*`);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  });

  afterAll(async () => {
    // Run generic teardown (which no longer includes redis.quit())
    await teardownIntegrationTest(setup);
    // Disconnect shared redis client if required by global teardown
    // await redisClient.quit();
  });

  describe('Event Service Integration', () => {
    it('should fetch events from API, store in database, and cache them', async () => {
      const syncResult = await eventService.syncEventsFromApi()();

      expect(E.isRight(syncResult)).toBe(true);
      if (E.isRight(syncResult)) {
        const events = syncResult.right;
        expect(events.length).toBeGreaterThan(0);
        const firstEvent = events[0];
        expect(firstEvent).toHaveProperty('id');
        expect(firstEvent).toHaveProperty('name');
        expect(firstEvent).toHaveProperty('deadlineTime');
      }

      const dbEvents = await prisma.event.findMany();
      expect(dbEvents.length).toBeGreaterThan(0);

      const cacheKey = `${cachePrefix}::${testSeason}`;
      // Use the imported singleton redisClient for the check
      const keyExists = await redisClient.exists(cacheKey);
      expect(keyExists).toBe(1);
    });

    it('should fetch current event after syncing', async () => {
      await eventService.syncEventsFromApi()();
      const currentEventResult = await eventService.getCurrentEvent()();

      expect(E.isRight(currentEventResult)).toBe(true);
      if (E.isRight(currentEventResult) && currentEventResult.right) {
        const currentEvent = currentEventResult.right;
        expect(currentEvent).toHaveProperty('isCurrent', true);
      }
    });

    it('should fetch next event after syncing', async () => {
      await eventService.syncEventsFromApi()();
      const nextEventResult = await eventService.getNextEvent()();

      expect(E.isRight(nextEventResult)).toBe(true);
      if (E.isRight(nextEventResult) && nextEventResult.right) {
        const nextEvent = nextEventResult.right;
        expect(nextEvent).toHaveProperty('isNext', true);
      }
    });

    it('should get event by ID after syncing', async () => {
      const syncResult = await eventService.syncEventsFromApi()();

      if (E.isRight(syncResult)) {
        const events = syncResult.right;
        if (events.length > 0) {
          const firstEventId = events[0].id;
          const eventResult = await eventService.getEvent(firstEventId)();

          expect(E.isRight(eventResult)).toBe(true);
          if (E.isRight(eventResult) && eventResult.right) {
            expect(eventResult.right.id).toEqual(firstEventId);
          }
        }
      }
    });
  });

  describe('Event Workflow Integration', () => {
    it('should execute the sync events workflow end-to-end', async () => {
      const workflows = eventWorkflows(eventService);
      const result = await workflows.syncEvents()();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right.context).toBeDefined();
        expect(result.right.duration).toBeGreaterThan(0);
        expect(result.right.result).toBeDefined();
        expect(result.right.result.length).toBeGreaterThan(0);

        const dbEvents = await prisma.event.findMany();
        expect(dbEvents.length).toEqual(result.right.result.length);
      }
    });
  });
});
