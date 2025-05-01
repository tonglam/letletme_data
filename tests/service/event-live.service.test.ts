import { createEventCache } from 'domain/event/cache';
import { EventCache } from 'domain/event/types';
import { createEventFixtureCache } from 'domain/event-fixture/cache';
import { EventFixtureCache } from 'domain/event-fixture/types';
import { createEventLiveCache } from 'domain/event-live/cache';
import { EventLiveCache } from 'domain/event-live/types';
import { createPlayerCache } from 'domain/player/cache';
import { PlayerCache } from 'domain/player/types';
import { createTeamCache } from 'domain/team/cache';
import { TeamCache } from 'domain/team/types';

import { beforeAll, describe, expect, it } from 'bun:test';
import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import { createFplBootstrapDataService } from 'data/fpl/bootstrap.data';
import { createFplLiveDataService } from 'data/fpl/live.data';
import { FplBootstrapDataService, FplLiveDataService } from 'data/types';
import * as E from 'fp-ts/Either';
import { redisClient } from 'infrastructure/cache/client';
import { Logger } from 'pino';
import { createEventRepository } from 'repository/event/repository';
import { EventRepository } from 'repository/event/types';
import { createEventLiveRepository } from 'repository/event-live/repository';
import { EventLiveRepository } from 'repository/event-live/types';
import { createEventService } from 'service/event/service';
import { EventService } from 'service/event/types';
import { createEventLiveService } from 'service/event-live/service';
import { EventLiveService } from 'service/event-live/types';
import { createEventLiveWorkflows } from 'service/event-live/workflow';
import { WorkflowResult } from 'service/types';
import { EventId } from 'types/domain/event.type';

import { IntegrationTestSetupResult, setupIntegrationTest } from '../setup/integrationTestSetup';

describe('Event Live Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let logger: Logger;
  let eventLiveCache: EventLiveCache;
  let playerCache: PlayerCache;
  let teamCache: TeamCache;
  let eventCache: EventCache;
  let eventFixtureCache: EventFixtureCache;
  let fplDataService: FplLiveDataService;
  let fplBootstrapDataService: FplBootstrapDataService;
  let eventLiveService: EventLiveService;
  let eventLiveRepository: EventLiveRepository;
  let eventRepository: EventRepository;
  let eventService: EventService;

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

    // Data Services
    fplDataService = createFplLiveDataService();
    fplBootstrapDataService = createFplBootstrapDataService();

    // Services
    eventService = createEventService(
      fplBootstrapDataService,
      eventRepository,
      eventCache,
      eventFixtureCache,
    );
    eventLiveService = createEventLiveService(
      fplDataService,
      eventLiveRepository,
      eventLiveCache,
      teamCache,
      playerCache,
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
      const workflows = createEventLiveWorkflows(eventService, eventLiveService);

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
