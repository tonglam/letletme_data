import { createEventCache } from 'domain/event/cache';
import { type EventCache } from 'domain/event/types';
import { createEventFixtureCache } from 'domain/event-fixture/cache';
import { type EventFixtureCache } from 'domain/event-fixture/types';
import { createTeamCache } from 'domain/team/cache';
import { type TeamCache } from 'domain/team/types';
import { createTeamFixtureCache } from 'domain/team-fixture/cache';
import { type TeamFixtureCache } from 'domain/team-fixture/types';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import { createFplBootstrapDataService } from 'data/fpl/bootstrap.data';
import { createFplFixtureDataService } from 'data/fpl/fixture.data';
import { type FplBootstrapDataService, type FplFixtureDataService } from 'data/types';
import * as E from 'fp-ts/Either';
import { redisClient } from 'infrastructure/cache/client';
import { type Logger } from 'pino';
import { createEventRepository } from 'repository/event/repository';
import { type EventRepository } from 'repository/event/types';
import { createEventFixtureRepository } from 'repository/event-fixture/repository';
import { type EventFixtureRepository } from 'repository/event-fixture/types';
import { createEventService } from 'service/event/service';
import { type EventService } from 'service/event/types';
import { eventWorkflows } from 'service/event/workflow';
import { createFixtureService } from 'service/fixture/service';
import { type FixtureService } from 'service/fixture/types';
import { type EventId } from 'types/domain/event.type';

import {
  type IntegrationTestSetupResult,
  setupIntegrationTest,
} from '../../setup/integrationTestSetup';

describe('Event Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let db: IntegrationTestSetupResult['db'];
  let logger: Logger;
  let eventRepository: EventRepository;
  let eventCache: EventCache;
  let fplBootstrapDataService: FplBootstrapDataService;
  let eventService: EventService;
  let fplFixtureDataService: FplFixtureDataService;
  let eventFixtureRepository: EventFixtureRepository;
  let eventFixtureCache: EventFixtureCache;
  let teamFixtureCache: TeamFixtureCache;
  let teamCache: TeamCache;
  let fixtureService: FixtureService;

  const eventCachePrefix = CachePrefix.EVENT;
  const fixtureCachePrefix = CachePrefix.FIXTURE;
  const teamCachePrefix = CachePrefix.TEAM;
  const season = '2425';

  beforeAll(async () => {
    setup = await setupIntegrationTest();
    db = setup.db;
    logger = setup.logger;

    try {
      await redisClient.ping();
    } catch (error) {
      logger.error(
        { err: error },
        'Shared redisClient ping failed in beforeAll. Ensure it is connected globally.',
      );
    }

    eventRepository = createEventRepository();
    eventCache = createEventCache({
      keyPrefix: eventCachePrefix,
      season: season,
      ttlSeconds: DefaultTTL.EVENT,
    });
    fplBootstrapDataService = createFplBootstrapDataService();

    fplFixtureDataService = createFplFixtureDataService();
    eventFixtureRepository = createEventFixtureRepository();
    eventFixtureCache = createEventFixtureCache({
      keyPrefix: fixtureCachePrefix,
      season: season,
      ttlSeconds: DefaultTTL.FIXTURE,
    });
    teamFixtureCache = createTeamFixtureCache({
      keyPrefix: fixtureCachePrefix,
      season: season,
      ttlSeconds: DefaultTTL.FIXTURE,
    });
    teamCache = createTeamCache({
      keyPrefix: teamCachePrefix,
      season: season,
      ttlSeconds: DefaultTTL.TEAM,
    });

    fixtureService = createFixtureService(
      fplFixtureDataService,
      eventFixtureRepository,
      eventFixtureCache,
      teamFixtureCache,
      teamCache,
    );

    eventService = createEventService(
      fplBootstrapDataService,
      fixtureService,
      eventRepository,
      eventCache,
    );
  });

  afterAll(async () => {
    // No explicit teardown needed
  });

  describe('Event Service Integration', () => {
    it('should fetch events from API, store in database, and cache them', async () => {
      const syncResult = await eventService.syncEventsFromApi()();

      expect(E.isRight(syncResult)).toBe(true);

      if (E.isRight(syncResult)) {
        const dbEvents = await db.query.events.findMany();
        expect(dbEvents.length).toBeGreaterThan(0);
        const firstEvent = dbEvents[0];
        expect(firstEvent).toHaveProperty('id');
        expect(firstEvent).toHaveProperty('name');
        expect(firstEvent).toHaveProperty('deadlineTime');

        const cacheKey = `${eventCachePrefix}::${season}`;
        const keyExists = await redisClient.exists(cacheKey);
        expect(keyExists).toBe(1);
      }
    });

    it('should fetch current event after syncing', async () => {
      const syncResult = await eventService.syncEventsFromApi()();
      expect(E.isRight(syncResult)).toBe(true);

      const currentEventResult = await eventService.getCurrentEvent()();

      expect(E.isRight(currentEventResult)).toBe(true);
      if (E.isRight(currentEventResult) && currentEventResult.right) {
        const currentEvent = currentEventResult.right;
        expect(currentEvent).toBeDefined();
        expect(currentEvent).not.toBeNull();
        expect(currentEvent).toHaveProperty('isCurrent', true);
      }
    });

    it('should get event by ID after syncing', async () => {
      const syncResult = await eventService.syncEventsFromApi()();
      expect(E.isRight(syncResult)).toBe(true);

      const eventFromDb = await db.query.events.findFirst();
      expect(eventFromDb).not.toBeNull();

      if (eventFromDb) {
        const eventIdToGet = eventFromDb.id as EventId;
        const eventResult = await eventService.getEvent(eventIdToGet)();

        expect(E.isRight(eventResult)).toBe(true);
        if (E.isRight(eventResult) && eventResult.right) {
          expect(eventResult.right).toBeDefined();
          expect(eventResult.right).not.toBeNull();
          expect(eventResult.right).toHaveProperty('id', eventIdToGet);
        }
      }
    });

    it('should fetch last event after syncing', async () => {
      const syncResult = await eventService.syncEventsFromApi()();
      expect(E.isRight(syncResult)).toBe(true);

      const currentEventResult = await eventService.getCurrentEvent()();
      expect(E.isRight(currentEventResult)).toBe(true);
      if (E.isRight(currentEventResult) && currentEventResult.right) {
        const currentEvent = currentEventResult.right;
        if ((currentEvent.id as number) > 1) {
          const lastEventResult = await eventService.getLastEvent()();
          expect(E.isRight(lastEventResult)).toBe(true);
          if (E.isRight(lastEventResult) && lastEventResult.right) {
            expect(lastEventResult.right.id as number).toEqual((currentEvent.id as number) - 1);
          }
        } else {
          console.warn('Current event is 1, skipping getLastEvent check.');
        }
      }
    });

    it('should fetch next event after syncing', async () => {
      const syncResult = await eventService.syncEventsFromApi()();
      expect(E.isRight(syncResult)).toBe(true);

      const currentEventResult = await eventService.getCurrentEvent()();
      expect(E.isRight(currentEventResult)).toBe(true);
      if (E.isRight(currentEventResult) && currentEventResult.right) {
        const currentEvent = currentEventResult.right;
        const allEventsResult = await eventService.getEvents()();
        expect(E.isRight(allEventsResult)).toBe(true);
        if (E.isRight(allEventsResult) && allEventsResult.right) {
          const maxEventId = Math.max(...allEventsResult.right.map((e) => e.id as number));
          if ((currentEvent.id as number) < maxEventId) {
            const nextEventResult = await eventService.getNextEvent()();
            expect(E.isRight(nextEventResult)).toBe(true);
            if (E.isRight(nextEventResult) && nextEventResult.right) {
              expect(nextEventResult.right.id as number).toEqual((currentEvent.id as number) + 1);
            }
          } else {
            console.warn(
              `Current event ${currentEvent.id as number} is the last event, skipping getNextEvent check.`,
            );
          }
        }
      }
    });

    it('should fetch all events after syncing', async () => {
      const syncResult = await eventService.syncEventsFromApi()();
      expect(E.isRight(syncResult)).toBe(true);

      const allEventsResult = await eventService.getEvents()();

      expect(E.isRight(allEventsResult)).toBe(true);
      if (E.isRight(allEventsResult) && allEventsResult.right) {
        const allEvents = allEventsResult.right;
        expect(Array.isArray(allEvents)).toBe(true);
        expect(allEvents.length).toBeGreaterThan(0);
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
        expect(result.right).toBeDefined();
        expect(result.right).not.toBeNull();
        expect(result.right).toHaveProperty('context');
        expect(result.right).toHaveProperty('duration');
        expect(result.right.duration).toBeGreaterThan(0);

        const dbEvents = await db.query.events.findMany();
        expect(dbEvents.length).toBeGreaterThan(0);
      }
    });
  });
});
