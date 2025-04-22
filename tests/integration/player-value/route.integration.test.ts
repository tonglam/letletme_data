import { PrismaClient } from '@prisma/client';
import express, { Express } from 'express';
import { Logger } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Config
import { playerValueRouter } from '../../../src/api/player-value/player-value.route';
import { CachePrefix } from '../../../src/configs/cache/cache.config';
// Infrastructure
import { createFplBootstrapDataService } from '../../../src/data/fpl/bootstrap.data';
import { FplBootstrapDataService } from '../../../src/data/types';
import { createEventCache } from '../../../src/domains/event/cache';
import { EventCache } from '../../../src/domains/event/types';
import { createPlayerCache } from '../../../src/domains/player/cache';
import { PlayerCache } from '../../../src/domains/player/types';
import { createPlayerValueCache } from '../../../src/domains/player-value/cache';
import { PlayerValueCache } from '../../../src/domains/player-value/types';
import { createTeamCache } from '../../../src/domains/team/cache';
import { TeamCache } from '../../../src/domains/team/types';
import { redisClient } from '../../../src/infrastructures/cache/client';
import { HTTPClient } from '../../../src/infrastructures/http';
// Repository Types
import { createEventRepository } from '../../../src/repositories/event/repository';
import { EventRepository } from '../../../src/repositories/event/type';
import { createPlayerRepository } from '../../../src/repositories/player/repository';
import { PlayerRepository } from '../../../src/repositories/player/type';
import { createPlayerValueRepository } from '../../../src/repositories/player-value/repository';
import { PlayerValueRepository } from '../../../src/repositories/player-value/type';
import { createTeamRepository } from '../../../src/repositories/team/repository';
import { TeamRepository } from '../../../src/repositories/team/type';
// Domain Types (Cache etc.)
// Service Types
import { createEventService } from '../../../src/services/event/service';
import { EventService } from '../../../src/services/event/types';
import { createPlayerService } from '../../../src/services/player/service';
import { createPlayerValueService } from '../../../src/services/player-value/service';
import { PlayerValueService } from '../../../src/services/player-value/types';
import { createTeamService } from '../../../src/services/team/service';
// Data Layer Types
// Domain Specific Types
import { PlayerValueId } from '../../../src/types/domain/player-value.type';
// Repository Factories
// Domain Factories (Cache)
// Data Layer Factories
// Service Factories
// Workflow Imports
// API Router
// Utilities
import { formatYYYYMMDD } from '../../../src/utils/date.util';
// Test Setup
import {
  IntegrationTestSetupResult,
  setupIntegrationTest,
  teardownIntegrationTest,
} from '../../setup/integrationTestSetup';

describe('PlayerValue Routes Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let app: Express;
  let prisma: PrismaClient;
  let logger: Logger;
  let httpClient: HTTPClient;
  let playerValueRepository: PlayerValueRepository;
  let playerValueCache: PlayerValueCache;
  let fplDataService: FplBootstrapDataService;
  let playerValueService: PlayerValueService;
  let eventRepository: EventRepository;
  let eventCache: EventCache;
  let eventService: EventService;
  let teamRepository: TeamRepository;
  let teamCache: TeamCache;
  let playerRepository: PlayerRepository;
  let playerCache: PlayerCache;

  const cachePrefix = CachePrefix.PLAYER_VALUE;
  const eventCachePrefix = CachePrefix.EVENT;
  const teamCachePrefix = CachePrefix.TEAM;
  const playerCachePrefix = CachePrefix.PLAYER;
  const testSeason = '2425';

  beforeAll(async () => {
    setup = await setupIntegrationTest();
    prisma = setup.prisma;
    logger = setup.logger;
    httpClient = setup.httpClient;

    try {
      await redisClient.ping();
    } catch (error) {
      logger.error({ err: error }, 'Shared redisClient ping failed in beforeAll.');
    }

    fplDataService = createFplBootstrapDataService(httpClient, logger);

    eventRepository = createEventRepository(prisma);
    eventCache = createEventCache(eventRepository, {
      keyPrefix: eventCachePrefix,
      season: testSeason,
    });
    eventService = createEventService(fplDataService, eventRepository, eventCache);

    teamRepository = createTeamRepository(prisma);
    teamCache = createTeamCache(teamRepository, {
      keyPrefix: teamCachePrefix,
      season: testSeason,
    });

    playerRepository = createPlayerRepository(prisma);
    playerCache = createPlayerCache(playerRepository, {
      keyPrefix: playerCachePrefix,
      season: testSeason,
    });

    playerValueRepository = createPlayerValueRepository(prisma);
    playerValueCache = createPlayerValueCache({
      keyPrefix: cachePrefix,
      ttlSeconds: 3600,
    });
    playerValueService = createPlayerValueService(
      fplDataService,
      playerValueRepository,
      playerValueCache,
      eventCache,
      teamCache,
      playerCache,
    );

    app = express();
    app.use(express.json());
    app.use('/player-values', playerValueRouter(playerValueService));
  });

  beforeEach(async () => {
    await prisma.playerValue.deleteMany({});
    await prisma.event.deleteMany({});
    await prisma.team.deleteMany({});
    await prisma.player.deleteMany({});

    const valueKeys = await redisClient.keys(`${cachePrefix}::${testSeason}*`);
    if (valueKeys.length > 0) await redisClient.del(valueKeys);
    const eventKeys = await redisClient.keys(`${eventCachePrefix}::${testSeason}*`);
    if (eventKeys.length > 0) await redisClient.del(eventKeys);
    const teamKeys = await redisClient.keys(`${teamCachePrefix}::${testSeason}*`);
    if (teamKeys.length > 0) await redisClient.del(teamKeys);
    const playerKeys = await redisClient.keys(`${playerCachePrefix}::${testSeason}*`);
    if (playerKeys.length > 0) await redisClient.del(playerKeys);

    const teamService = createTeamService(fplDataService, teamRepository, teamCache);
    const playerService = createPlayerService(fplDataService, playerRepository, playerCache);
    await teamService.syncTeamsFromApi()();
    await playerService.syncPlayersFromApi()();
    await eventService.syncEventsFromApi()();
    await playerValueService.syncPlayerValuesFromApi()();
  });

  afterAll(async () => {
    await teardownIntegrationTest(setup);
  });

  // --- Test Cases ---

  it('GET /player-values/date/:changeDate should return player values for that date', async () => {
    const today = formatYYYYMMDD();
    const res = await request(app).get(`/player-values/date/${today}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
    const values = res.body.data;
    if (values.length > 0) {
      expect(values[0]).toHaveProperty('element');
      expect(values[0]).toHaveProperty('value');
      expect(values[0]).toHaveProperty('lastValue');
      expect(values[0]).toHaveProperty('changeType');
      expect(values[0]).toHaveProperty('changeDate');
    } else {
      console.warn(`[Test Warning] No player values found for date ${today} during test run.`);
    }
  });

  it('GET /player-values/element/:element should return the player value data', async () => {
    const dbValue = await prisma.playerValue.findFirst();
    if (!dbValue) {
      throw new Error('Could not retrieve a player value from DB for testing');
    }
    const targetElementId = dbValue.element;

    const res = await request(app).get(`/player-values/element/${targetElementId}`);

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    const valueData = res.body.data[0];
    expect(valueData.element).toBe(targetElementId);
    expect(valueData).toHaveProperty('value');
    expect(valueData).toHaveProperty('lastValue');
    expect(valueData).toHaveProperty('changeType');
  });

  it('GET /player-values/:id should return 404 if player value ID does not exist', async () => {
    const nonExistentValueId = 999999999 as PlayerValueId;
    const res = await request(app).get(`/player-values/${nonExistentValueId}`);

    expect(res.status).toBe(404);
  });
});
