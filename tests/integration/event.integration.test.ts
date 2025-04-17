import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import * as E from 'fp-ts/Either';
import Redis from 'ioredis';
import pino from 'pino';

import { apiConfig } from '../../src/configs/api/api.config';
import { CachePrefix } from '../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../src/data/fpl/bootstrap.data';
import { createEventCache } from '../../src/domains/event/cache';
import { EventCache, EventRepository } from '../../src/domains/event/types';
import { createHTTPClient } from '../../src/infrastructures/http/client';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructures/http/client/utils';
import { createEventRepository } from '../../src/repositories/event/repository';
import { createEventService } from '../../src/services/event/service';
import { EventService } from '../../src/services/event/types';
import { eventWorkflows } from '../../src/services/event/workflow';
import { Events } from '../../src/types/domain/event.type';

describe('Event Integration Tests', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let eventRepository: EventRepository;
  let eventCache: EventCache;
  let eventService: EventService;
  let logger: pino.Logger;

  beforeAll(async () => {
    // Set up real connections to resources
    prisma = new PrismaClient();
    logger = pino({ level: 'info' });

    // Create Redis client using environment variables
    redis = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_DB || '0', 10),
    });

    // Wait for Redis connection to be ready
    if (redis.status !== 'ready') {
      await new Promise<void>((resolve) => {
        redis.once('ready', () => resolve());
      });
    }

    // Create HTTP client for API requests
    const httpClient = createHTTPClient({
      client: axios.create({ baseURL: apiConfig.baseUrl }), // Corrected baseURL usage
      retryConfig: {
        ...DEFAULT_RETRY_CONFIG,
        attempts: 3,
        baseDelay: 1000,
        maxDelay: 5000,
      },
      logger,
    });

    // Create bootstrap data service for API data
    const bootstrapDataService = createFplBootstrapDataService(httpClient, logger);

    // Create repository with real database connection
    eventRepository = createEventRepository(prisma);

    // Create cache with real Redis connection and configuration
    eventCache = createEventCache(eventRepository, {
      keyPrefix: `test:${CachePrefix.EVENT}`,
      season: '2425',
    });

    // Create the full event service with real dependencies
    eventService = createEventService(bootstrapDataService, eventRepository, eventCache);
  });

  beforeEach(async () => {
    // Clear data before each test
    await prisma.event.deleteMany({});

    // Flush Redis database for test prefix
    const keys = await redis.keys('test:*');
    if (keys.length > 0) {
      await redis.del(keys);
    }
  });

  afterAll(async () => {
    // Clean up after all tests
    await prisma.$disconnect();
    await redis.quit();
  });

  describe('Event Service Integration', () => {
    it('should fetch events from API, store in database, and cache them', async () => {
      // Sync events from API
      const syncResult = await eventService.syncEventsFromApi()();

      // Verify API fetch was successful
      expect(E.isRight(syncResult)).toBe(true);
      if (E.isRight(syncResult)) {
        const events = syncResult.right as Events;
        expect(events.length).toBeGreaterThan(0);

        // Verify events have expected structure
        const firstEvent = events[0];
        expect(firstEvent).toHaveProperty('id');
        expect(firstEvent).toHaveProperty('name');
        expect(firstEvent).toHaveProperty('deadlineTime');
      }

      // Verify data was stored in database
      const dbEvents = await prisma.event.findMany();
      expect(dbEvents.length).toBeGreaterThan(0);

      // Verify data was cached in Redis
      // Check if the hash key exists (using the prefix and season configured for eventCache)
      const cacheKey = `test:${CachePrefix.EVENT}::2425`; // Align with the cache config
      const keyExists = await redis.exists(cacheKey);
      expect(keyExists).toBe(1); // Assert that the key exists
    });

    it('should fetch current event after syncing', async () => {
      // First sync events
      await eventService.syncEventsFromApi()();

      // Then fetch current event
      const currentEventResult = await eventService.getCurrentEvent()();

      expect(E.isRight(currentEventResult)).toBe(true);
      if (E.isRight(currentEventResult) && currentEventResult.right) {
        const currentEvent = currentEventResult.right;
        expect(currentEvent).toHaveProperty('isCurrent', true);
      }
    });

    it('should fetch next event after syncing', async () => {
      // First sync events
      await eventService.syncEventsFromApi()();

      // Then fetch next event
      const nextEventResult = await eventService.getNextEvent()();

      expect(E.isRight(nextEventResult)).toBe(true);
      if (E.isRight(nextEventResult) && nextEventResult.right) {
        const nextEvent = nextEventResult.right;
        expect(nextEvent).toHaveProperty('isNext', true);
      }
    });

    it('should get event by ID after syncing', async () => {
      // First sync events
      const syncResult = await eventService.syncEventsFromApi()();

      if (E.isRight(syncResult)) {
        const events = syncResult.right as Events;
        if (events.length > 0) {
          // Get first event ID
          const firstEventId = events[0].id;

          // Fetch that specific event
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
      // Create workflow instance
      const workflows = eventWorkflows(eventService);

      // Execute sync workflow
      const result = await workflows.syncEvents()();

      // Verify workflow execution
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        // Check workflow metadata exists
        expect(result.right.context).toBeDefined();
        expect(result.right.context.workflowId).toBeDefined();
        expect(result.right.duration).toBeGreaterThan(0);

        // Check workflow result data
        expect(result.right.result).toBeDefined();
        expect(result.right.result.length).toBeGreaterThan(0);

        // Verify events were stored in database
        const dbEvents = await prisma.event.findMany();
        expect(dbEvents.length).toEqual(result.right.result.length);
      }
    });
  });
});
