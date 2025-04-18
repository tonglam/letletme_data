import { PrismaClient } from '@prisma/client';
import express, { Express } from 'express';
import * as E from 'fp-ts/Either';
import { Logger } from 'pino';
import request from 'supertest';
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
import { eventRouter } from '../../../src/api/routes/event.route';
import { CachePrefix } from '../../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../../src/data/fpl/fetches/bootstrap/bootstrap.data';
import { FplBootstrapDataService } from '../../../src/data/types';
import { createEventCache } from '../../../src/domains/event/cache';
import { EventCache, EventRepository } from '../../../src/domains/event/types';
import { HTTPClient } from '../../../src/infrastructures/http/client';
import { createEventRepository } from '../../../src/repositories/event/repository';
import { createEventService } from '../../../src/services/event/service';
import { EventService } from '../../../src/services/event/types';
import { Event, EventId } from '../../../src/types/domain/event.type';

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
    await eventService.syncEventsFromApi()();
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

  it('GET /events/current should return the current event within a data object', async () => {
    const res = await request(app).get('/events/current');

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    expect(res.body).toHaveProperty('data'); // Check data property exists
    expect(res.body.data).toHaveProperty('isCurrent', true); // Check nested property
  });

  it('GET /events/next should return the next event within a data object', async () => {
    const res = await request(app).get('/events/next');

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    expect(res.body).toHaveProperty('data'); // Check data property exists
    expect(res.body.data).toHaveProperty('isNext', true); // Check nested property
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

  it('GET /events/:id should return 404 if event ID does not exist', async () => {
    const nonExistentEventId = 99999 as EventId;
    const res = await request(app).get(`/events/${nonExistentEventId}`);

    expect(res.status).toBe(404);
    // Optionally check the error response structure if your API provides one
    // expect(res.body).toHaveProperty('error');
  });
});
