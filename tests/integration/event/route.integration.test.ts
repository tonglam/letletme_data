import { PrismaClient } from '@prisma/client';
import express, { Express } from 'express';
import * as E from 'fp-ts/Either';
import { Logger } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Use the generic setup

// Import the SHARED redis client used by the application

// Specific imports for this test suite
import { eventRouter } from '../../../src/api/event/route';
import { CachePrefix } from '../../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../../src/data/fpl/bootstrap.data';
import { FplBootstrapDataService } from '../../../src/data/types';
import { createEventCache } from '../../../src/domains/event/cache';
import { EventCache } from '../../../src/domains/event/types';
import { redisClient } from '../../../src/infrastructures/cache/client';
import { HTTPClient } from '../../../src/infrastructures/http';
import { createEventRepository } from '../../../src/repositories/event/repository';
import { EventRepository } from '../../../src/repositories/event/type';
import { createEventService } from '../../../src/services/event/service';
import { EventService } from '../../../src/services/event/types';
import { Event, EventId } from '../../../src/types/domain/event.type';
import { APIErrorCode } from '../../../src/types/error.type';
import {
  IntegrationTestSetupResult,
  setupIntegrationTest,
  teardownIntegrationTest,
} from '../../setup/integrationTestSetup';

describe('Event Routes Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let app: Express;
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
    setup = await setupIntegrationTest();
    prisma = setup.prisma;
    logger = setup.logger;
    httpClient = setup.httpClient;

    // Ping shared client (optional)
    try {
      await redisClient.ping();
    } catch (error) {
      logger.error({ err: error }, 'Shared redisClient ping failed in beforeAll.');
    }

    eventRepository = createEventRepository(prisma);
    eventCache = createEventCache(eventRepository, {
      keyPrefix: cachePrefix,
      season: testSeason,
    });
    fplDataService = createFplBootstrapDataService(httpClient, logger);
    eventService = createEventService(fplDataService, eventRepository, eventCache);

    app = express();
    app.use(express.json());
    app.use('/events', eventRouter(eventService));
  });

  beforeEach(async () => {
    await prisma.event.deleteMany({});
    // Use shared client for cleanup
    const keys = await redisClient.keys(`${cachePrefix}::${testSeason}*`);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
    // Run the sync and check the result
    const syncResult = await eventService.syncEventsFromApi()();
    if (E.isLeft(syncResult)) {
      // Log the error for debugging
      logger.error(
        { error: syncResult.left },
        'Sync failed in beforeEach hook of route tests. Subsequent tests will likely fail.',
      );
      // Fail fast if sync didn't succeed
      throw new Error(`Event sync failed during test setup: ${syncResult.left.message}`);
    }
  });

  afterAll(async () => {
    await teardownIntegrationTest(setup);
    // await redisClient.quit(); // If global teardown needed
  });

  // --- Test Cases ---

  it('GET /events should return all events within a data object', async () => {
    const res = await request(app).get('/events');

    expect(res.status).toBe(200);
    // Check for the { data: [...] } structure
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
    const events = res.body.data as Event[];
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toHaveProperty('id');
    expect(events[0]).toHaveProperty('name');
  });

  it('GET /events/current should return the current event or 404 if not found', async () => {
    const res = await request(app).get('/events/current');

    // Expect either 200 OK or 404 Not Found
    expect([200, 404]).toContain(res.status);

    if (res.status === 200) {
      expect(res.body).toBeDefined();
      expect(res.body).toHaveProperty('data');
      expect(res.body.data).toHaveProperty('isCurrent', true);
    } else {
      // Check for expected 404 or log unexpected 400
      if (res.status === 404) {
        expect(res.body).toHaveProperty('error');
        expect(res.body.error.code).toEqual(APIErrorCode.NOT_FOUND);
      } else if (res.status === 400) {
        // Log the unexpected 400 error body for debugging
        console.error('Unexpected 400 error body for /current:', JSON.stringify(res.body));
        // Optionally, fail the test explicitly here if 400 is always wrong
        // expect(res.status).toBe(200); // This would fail and show the 400
      }
      // The initial expect([200, 404]).toContain(res.status) will handle other statuses
    }
  });

  it('GET /events/next should return the next event or 404 if not found', async () => {
    const res = await request(app).get('/events/next');

    // Expect either 200 OK or 404 Not Found
    expect([200, 404]).toContain(res.status);

    if (res.status === 200) {
      expect(res.body).toBeDefined();
      expect(res.body).toHaveProperty('data');
      expect(typeof res.body.data).toBe('object');
      expect(res.body.data).toHaveProperty('id');
      expect(res.body.data).toHaveProperty('name');
      expect(res.body.data).toHaveProperty('isNext', true);
    } else {
      // Check for expected 404 or log unexpected 400
      if (res.status === 404) {
        expect(res.body).toHaveProperty('error');
        expect(res.body.error.code).toEqual(APIErrorCode.NOT_FOUND);
      } else if (res.status === 400) {
        // Log the unexpected 400 error body for debugging
        console.error('Unexpected 400 error body for /next:', JSON.stringify(res.body));
        // Optionally, fail the test explicitly here if 400 is always wrong
        // expect(res.status).toBe(200); // This would fail and show the 400
      }
      // The initial expect([200, 404]).toContain(res.status) will handle other statuses
    }
  });

  it('GET /events/:id should return the event within a data object', async () => {
    const syncResult = await eventService.getEvents()(); // Get all synced events
    let targetEventId: EventId | null = null;
    if (E.isRight(syncResult) && syncResult.right && syncResult.right.length > 0) {
      targetEventId = syncResult.right[0].id;
    } else {
      throw new Error('Could not retrieve events to get an ID for testing');
    }

    const res = await request(app).get(`/events/${targetEventId}`);

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    expect(res.body).toHaveProperty('data'); // Check data property exists
    expect(res.body.data.id).toBe(targetEventId); // Check nested property
    expect(res.body.data).toHaveProperty('name');
  });

  it('GET /events/:id should return 400 if event ID is invalid', async () => {
    const invalidEventId = 9999 as EventId;
    const res = await request(app).get(`/events/${invalidEventId}`);

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error.code).toEqual(APIErrorCode.VALIDATION_ERROR);
  });
});
