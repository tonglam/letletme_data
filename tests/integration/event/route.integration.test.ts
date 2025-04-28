import { PrismaClient } from '@prisma/client';
import express, { Express } from 'express';
import * as E from 'fp-ts/Either';
import { Logger } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Configs
import { eventRouter } from '../../../src/api/event/route';
import { CachePrefix, DefaultTTL } from '../../../src/configs/cache/cache.config';
// API
// Data Services
import { createFplBootstrapDataService } from '../../../src/data/fpl/bootstrap.data';
import { createFplFixtureDataService } from '../../../src/data/fpl/fixture.data';
import { FplBootstrapDataService, FplFixtureDataService } from '../../../src/data/types';
// Domains (Caches)
import { createEventCache } from '../../../src/domains/event/cache';
import { EventCache } from '../../../src/domains/event/types';
import { createEventFixtureCache } from '../../../src/domains/event-fixture/cache';
import { EventFixtureCache } from '../../../src/domains/event-fixture/types';
import { createTeamCache } from '../../../src/domains/team/cache';
import { TeamCache } from '../../../src/domains/team/types';
import { createTeamFixtureCache } from '../../../src/domains/team-fixture/cache';
import { TeamFixtureCache } from '../../../src/domains/team-fixture/types';
// Infrastructures
import { redisClient } from '../../../src/infrastructures/cache/client';
import { HTTPClient } from '../../../src/infrastructures/http';
// Repositories
import { createEventRepository } from '../../../src/repositories/event/repository';
import { EventRepository } from '../../../src/repositories/event/types';
import { createEventFixtureRepository } from '../../../src/repositories/event-fixture/repository';
import { EventFixtureRepository } from '../../../src/repositories/event-fixture/types';
// Services
import { createEventService } from '../../../src/services/event/service';
import { EventService } from '../../../src/services/event/types';
import { createFixtureService } from '../../../src/services/fixture/service';
import { FixtureService } from '../../../src/services/fixture/types';
// Domain Types
import { Event, EventId } from '../../../src/types/domain/event.type';
import { APIErrorCode } from '../../../src/types/error.type';
// Test Setup
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
  // Event related dependencies
  let eventRepository: EventRepository;
  let eventCache: EventCache;
  let fplBootstrapDataService: FplBootstrapDataService;
  let eventService: EventService;
  // Fixture related dependencies needed for FixtureService
  let fplFixtureDataService: FplFixtureDataService;
  let eventFixtureRepository: EventFixtureRepository;
  let eventFixtureCache: EventFixtureCache;
  let teamFixtureCache: TeamFixtureCache;
  let teamCache: TeamCache;
  let fixtureService: FixtureService;

  const eventCachePrefix = CachePrefix.EVENT;
  const fixtureCachePrefix = CachePrefix.FIXTURE;
  const teamCachePrefix = CachePrefix.TEAM;
  const testSeason = '2425';

  beforeAll(async () => {
    setup = await setupIntegrationTest();
    prisma = setup.prisma;
    logger = setup.logger;
    httpClient = setup.httpClient;

    // Ping redis
    try {
      await redisClient.ping();
    } catch (error) {
      logger.error({ err: error }, 'Redis ping failed in beforeAll.');
    }

    // Instantiate Event dependencies
    eventRepository = createEventRepository(); // Corrected: no args
    eventCache = createEventCache({
      keyPrefix: eventCachePrefix,
      season: testSeason,
      ttlSeconds: DefaultTTL.EVENT, // Corrected: added ttlSeconds
    });
    fplBootstrapDataService = createFplBootstrapDataService(httpClient, logger);

    // Instantiate Fixture dependencies
    fplFixtureDataService = createFplFixtureDataService(httpClient, logger);
    eventFixtureRepository = createEventFixtureRepository(prisma);
    eventFixtureCache = createEventFixtureCache({
      keyPrefix: fixtureCachePrefix,
      season: testSeason,
      ttlSeconds: DefaultTTL.FIXTURE,
    });
    teamFixtureCache = createTeamFixtureCache({
      keyPrefix: fixtureCachePrefix,
      season: testSeason,
      ttlSeconds: DefaultTTL.FIXTURE,
    });
    teamCache = createTeamCache({
      keyPrefix: teamCachePrefix,
      season: testSeason,
      ttlSeconds: DefaultTTL.TEAM,
    });

    // Instantiate FixtureService with actual dependencies
    fixtureService = createFixtureService(
      fplFixtureDataService,
      eventFixtureRepository,
      eventFixtureCache,
      teamFixtureCache,
      teamCache,
    );

    // Instantiate EventService with the actual fixtureService
    eventService = createEventService(
      fplBootstrapDataService,
      fixtureService,
      eventRepository,
      eventCache,
    ); // Corrected: added fixtureService

    app = express();
    app.use(express.json());
    app.use('/events', eventRouter(eventService));
  });

  afterAll(async () => {
    await teardownIntegrationTest(setup);
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

  it('GET /events/last should return the last finished event or 404 if not found', async () => {
    const res = await request(app).get('/events/last');

    // Expect either 200 OK or 404 Not Found
    expect([200, 404]).toContain(res.status);

    if (res.status === 200) {
      expect(res.body).toBeDefined();
      expect(res.body).toHaveProperty('data');
      expect(typeof res.body.data).toBe('object');
      expect(res.body.data).toHaveProperty('id');
      expect(res.body.data).toHaveProperty('name');
    } else {
      // Check for expected 404
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error.code).toEqual(APIErrorCode.NOT_FOUND);
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

  it('POST /events/sync should trigger synchronization and return success', async () => {
    // Clear cache and DB before testing sync specifically
    await prisma.event.deleteMany({});
    const keys = await redisClient.keys(`${eventCachePrefix}::${testSeason}*`);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }

    const res = await request(app).post('/events/sync');

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    // The handler returns void on success, resulting in an empty body
    // expect(res.body).toHaveProperty('data');
    // expect(res.body.data).toEqual({ success: true });

    // Optional: Verify data was actually synced
    const eventsInDb = await prisma.event.findMany();
    expect(eventsInDb.length).toBeGreaterThan(0);
  });
});
