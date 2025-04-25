import { PrismaClient } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { Logger } from 'pino';
import { EventRepository } from 'src/repositories/event/types';
import { EventId } from 'src/types/domain/event.type';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CachePrefix } from '../../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../../src/data/fpl/bootstrap.data';
import { FplBootstrapDataService } from '../../../src/data/types';
import { createEventCache } from '../../../src/domains/event/cache';
import { EventCache } from '../../../src/domains/event/types';
import { redisClient } from '../../../src/infrastructures/cache/client';
import { HTTPClient } from '../../../src/infrastructures/http';
import { createEventRepository } from '../../../src/repositories/event/repository';
import { createEventService } from '../../../src/services/event/service';
import { EventService } from '../../../src/services/event/types';
import { eventWorkflows } from '../../../src/services/event/workflow';
import {
  IntegrationTestSetupResult,
  setupIntegrationTest,
  teardownIntegrationTest,
} from '../../setup/integrationTestSetup';

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
  const season = '2425';

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
    eventCache = createEventCache({
      keyPrefix: cachePrefix,
      season: season,
    });
    fplDataService = createFplBootstrapDataService(httpClient, logger);
    eventService = createEventService(fplDataService, eventRepository, eventCache);
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

      // Check if the sync operation itself succeeded
      expect(E.isRight(syncResult)).toBe(true);

      // Check database state after sync
      const dbEvents = await prisma.event.findMany();
      expect(dbEvents.length).toBeGreaterThan(0);
      const firstEvent = dbEvents[0];
      expect(firstEvent).toHaveProperty('id');
      expect(firstEvent).toHaveProperty('name');
      expect(firstEvent).toHaveProperty('deadlineTime');

      // Check cache state after sync
      const cacheKey = `${cachePrefix}::${season}`;
      const keyExists = await redisClient.exists(cacheKey);
      expect(keyExists).toBe(1);
    });

    it('should fetch current event after syncing', async () => {
      // Sync first
      const syncResult = await eventService.syncEventsFromApi()();
      expect(E.isRight(syncResult)).toBe(true); // Ensure sync succeeded

      // Then attempt to get the current event
      const currentEventResult = await eventService.getCurrentEvent()();

      expect(E.isRight(currentEventResult)).toBe(true);
      if (E.isRight(currentEventResult) && currentEventResult.right) {
        const currentEvent = currentEventResult.right;
        expect(currentEvent).toHaveProperty('isCurrent', true);
      }
    });

    it('should get event by ID after syncing', async () => {
      // Sync first
      const syncResult = await eventService.syncEventsFromApi()();
      expect(E.isRight(syncResult)).toBe(true); // Ensure sync succeeded

      // Get an event from the DB to test with
      const eventFromDb = await prisma.event.findFirst();
      expect(eventFromDb).not.toBeNull();

      if (eventFromDb) {
        const eventIdToGet = eventFromDb.id as EventId;
        const eventResult = await eventService.getEvent(eventIdToGet)();

        expect(E.isRight(eventResult)).toBe(true);
        if (E.isRight(eventResult) && eventResult.right) {
          expect(eventResult.right.id).toEqual(eventIdToGet);
        }
      }
    });

    it('should fetch last event after syncing', async () => {
      // Sync first
      const syncResult = await eventService.syncEventsFromApi()();
      expect(E.isRight(syncResult)).toBe(true);

      // Need current event to know what "last" is
      const currentEventResult = await eventService.getCurrentEvent()();
      expect(E.isRight(currentEventResult)).toBe(true);
      if (E.isRight(currentEventResult) && currentEventResult.right) {
        const currentEvent = currentEventResult.right;
        // Ensure there *is* a last event to fetch (e.g., if current is GW1)
        if (currentEvent.id > 1) {
          const lastEventResult = await eventService.getLastEvent()();
          expect(E.isRight(lastEventResult)).toBe(true);
          if (E.isRight(lastEventResult) && lastEventResult.right) {
            expect(lastEventResult.right.id).toEqual(currentEvent.id - 1);
          }
        } else {
          // If current event is 1, getLastEvent should fail or return nothing
          // The current implementation relies on cache which should be populated,
          // but finding event id 0 will fail. Adjust expectation based on desired behavior.
          // For now, just check the attempt was made if applicable.
          // Alternatively, skip this case or expect an error if the service guarantees one.
          console.warn('Current event is 1, skipping getLastEvent check.');
        }
      }
    });

    it('should fetch next event after syncing', async () => {
      // Sync first
      const syncResult = await eventService.syncEventsFromApi()();
      expect(E.isRight(syncResult)).toBe(true);

      // Need current event to know what "next" is
      const currentEventResult = await eventService.getCurrentEvent()();
      expect(E.isRight(currentEventResult)).toBe(true);
      if (E.isRight(currentEventResult) && currentEventResult.right) {
        const currentEvent = currentEventResult.right;
        // Fetch all events to check if there is a next one
        const allEventsResult = await eventService.getEvents()();
        expect(E.isRight(allEventsResult)).toBe(true);
        if (E.isRight(allEventsResult) && allEventsResult.right) {
          const maxEventId = Math.max(...allEventsResult.right.map((e) => e.id));
          // Ensure there *is* a next event to fetch
          if (currentEvent.id < maxEventId) {
            const nextEventResult = await eventService.getNextEvent()();
            expect(E.isRight(nextEventResult)).toBe(true);
            if (E.isRight(nextEventResult) && nextEventResult.right) {
              expect(nextEventResult.right.id).toEqual(currentEvent.id + 1);
            }
          } else {
            console.warn(
              `Current event ${currentEvent.id} is the last event, skipping getNextEvent check.`,
            );
          }
        }
      }
    });

    it('should fetch all events after syncing', async () => {
      // Sync first
      const syncResult = await eventService.syncEventsFromApi()();
      expect(E.isRight(syncResult)).toBe(true); // Ensure sync succeeded

      // Then attempt to get all events
      const allEventsResult = await eventService.getEvents()();

      expect(E.isRight(allEventsResult)).toBe(true);
      if (E.isRight(allEventsResult) && allEventsResult.right) {
        const allEvents = allEventsResult.right;
        expect(Array.isArray(allEvents)).toBe(true);
        expect(allEvents.length).toBeGreaterThan(0);
        // Check if the fetched events have the correct structure
        expect(allEvents[0]).toHaveProperty('id');
        expect(allEvents[0]).toHaveProperty('name');
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
        // // Removed assertions for result.right.result as the workflow doesn't return it
        // expect(result.right.result).toBeDefined();
        // expect(result.right.result.length).toBeGreaterThan(0);

        // Verify the side effect directly by checking the database
        const dbEvents = await prisma.event.findMany();
        expect(dbEvents.length).toBeGreaterThan(0); // Check that events were actually saved
        // // Optionally, compare count if the workflow *did* return it, but it doesn't.
        // expect(dbEvents.length).toEqual(result.right.result.length);
      }
    });
  });
});
