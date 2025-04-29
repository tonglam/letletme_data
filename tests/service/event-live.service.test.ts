import { createEventCache } from 'domain/event/cache';
import { type EventCache } from 'domain/event/types';
import { createEventFixtureCache } from 'domain/event-fixture/cache';
import { type EventFixtureCache } from 'domain/event-fixture/types';
import { createEventLiveCache } from 'domain/event-live/cache';
import { type EventLiveCache } from 'domain/event-live/types';
import { createPlayerCache } from 'domain/player/cache';
import { type PlayerCache } from 'domain/player/types';
import { createTeamCache } from 'domain/team/cache';
import { type TeamCache } from 'domain/team/types';
import { createTeamFixtureCache } from 'domain/team-fixture/cache';
import { type TeamFixtureCache } from 'domain/team-fixture/types';

import { beforeAll, describe, expect, it } from 'bun:test';
import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import { createFplBootstrapDataService } from 'data/fpl/bootstrap.data';
import { createFplFixtureDataService } from 'data/fpl/fixture.data';
import { createFplLiveDataService } from 'data/fpl/live.data';
import { type FplBootstrapDataService, type FplFixtureDataService } from 'data/types';
import { type FplLiveDataService } from 'data/types';
import * as E from 'fp-ts/Either';
import { redisClient } from 'infrastructure/cache/client';
import { type Logger } from 'pino';
import { createEventRepository } from 'repository/event/repository';
import { type EventRepository } from 'repository/event/types';
import { createEventFixtureRepository } from 'repository/event-fixture/repository';
import { type EventFixtureRepository } from 'repository/event-fixture/types';
import { createEventLiveRepository } from 'repository/event-live/repository';
import { type EventLiveRepository } from 'repository/event-live/types';
import { createEventService } from 'service/event/service';
import { type EventService } from 'service/event/types';
import { createEventLiveService } from 'service/event-live/service';
import { type EventLiveService } from 'service/event-live/types';
import { eventLiveWorkflows } from 'service/event-live/workflow';
import { createFixtureService } from 'service/fixture/service';
import { type FixtureService } from 'service/fixture/types';
import { type WorkflowResult } from 'service/types';
import { type EventId } from 'types/domain/event.type';

import {
  type IntegrationTestSetupResult,
  setupIntegrationTest,
} from '../setup/integrationTestSetup';

describe('Event Live Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let logger: Logger;
  let eventLiveCache: EventLiveCache;
  let playerCache: PlayerCache;
  let teamCache: TeamCache;
  let eventCache: EventCache;
  let eventFixtureCache: EventFixtureCache;
  let teamFixtureCache: TeamFixtureCache;
  let fplDataService: FplLiveDataService;
  let fplBootstrapDataService: FplBootstrapDataService;
  let fplFixtureDataService: FplFixtureDataService;
  let eventLiveService: EventLiveService;
  let eventLiveRepository: EventLiveRepository;
  let eventRepository: EventRepository;
  let eventFixtureRepository: EventFixtureRepository;
  let eventService: EventService;
  let fixtureService: FixtureService;

  const cachePrefix = CachePrefix.LIVE;
  const testEventId = 1;
  const season = '2425';

  beforeAll(async () => {
    setup = await setupIntegrationTest();
    logger = setup.logger;

    try {
      await redisClient.ping();
    } catch (error) {
      logger.error({ err: error }, 'Shared redisClient ping failed in beforeAll.');
    }

    // Repositories
    eventLiveRepository = createEventLiveRepository();
    eventRepository = createEventRepository();
    eventFixtureRepository = createEventFixtureRepository();

    // Caches
    eventLiveCache = createEventLiveCache({
      keyPrefix: cachePrefix,
      season: season,
      ttlSeconds: DefaultTTL.LIVE,
    });
    playerCache = createPlayerCache({
      keyPrefix: CachePrefix.PLAYER,
      season: season,
      ttlSeconds: DefaultTTL.PLAYER,
    });
    teamCache = createTeamCache({
      keyPrefix: CachePrefix.TEAM,
      season: season,
      ttlSeconds: DefaultTTL.TEAM,
    });
    eventCache = createEventCache({
      keyPrefix: CachePrefix.EVENT,
      season: season,
      ttlSeconds: DefaultTTL.EVENT,
    });
    eventFixtureCache = createEventFixtureCache({
      keyPrefix: CachePrefix.EVENT_FIXTURE,
      season: season,
      ttlSeconds: DefaultTTL.EVENT_FIXTURE,
    });
    teamFixtureCache = createTeamFixtureCache({
      keyPrefix: CachePrefix.TEAM_FIXTURE,
      season: season,
      ttlSeconds: DefaultTTL.TEAM_FIXTURE,
    });

    // Data Services
    fplDataService = createFplLiveDataService();
    fplBootstrapDataService = createFplBootstrapDataService();
    fplFixtureDataService = createFplFixtureDataService();

    // Services
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
    eventLiveService = createEventLiveService(
      fplDataService,
      eventLiveRepository,
      eventLiveCache,
      playerCache,
      teamCache,
      eventService,
    );
  });

  describe('Event Live Service Integration', () => {
    it('should attempt to sync live event data from API and update cache', async () => {
      const fetchDataResult = await fplDataService.getLives(testEventId as EventId)();
      if (E.isLeft(fetchDataResult)) {
        logger.error({ error: fetchDataResult.left }, 'DEBUG: Step 1 FAILED - Fetch/Validate');
        expect(E.isRight(fetchDataResult)).toBe(true);
        return;
      }

      const syncResult = await eventLiveService.syncEventLiveCacheFromApi(testEventId as EventId)();

      expect(E.isRight(syncResult)).toBe(true);
    });

    it('should retrieve live event data from cache if available after sync', async () => {
      await eventLiveService.syncEventLiveCacheFromApi(testEventId as EventId)();

      const getLiveResult = await eventLiveService.getEventLives(testEventId as EventId)();

      expect(E.isRight(getLiveResult)).toBe(true);
      if (E.isRight(getLiveResult)) {
        expect(getLiveResult.right).toBeDefined();
        expect(Array.isArray(getLiveResult.right)).toBe(true);
      } else if (E.isLeft(getLiveResult)) {
        throw new Error(
          `Expected Right from cache but got Left: ${JSON.stringify(getLiveResult.left)}`,
        );
      }
    });
  });

  describe('Event Live Workflow Integration', () => {
    it('should execute the sync event lives workflow end-to-end', async () => {
      const workflows = eventLiveWorkflows(eventLiveService);

      const result = await workflows.syncEventLives(testEventId as EventId)();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        const workflowResult = result.right as WorkflowResult;
        expect(workflowResult).toBeDefined();
        expect(workflowResult).toHaveProperty('context');
        expect(workflowResult).toHaveProperty('duration');
        expect(workflowResult.duration).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
