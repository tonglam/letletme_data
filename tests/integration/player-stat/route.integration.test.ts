import { PrismaClient } from '@prisma/client';
import express from 'express';
import * as E from 'fp-ts/Either';
import { Logger } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Setup

// Specific imports
import { playerStatRouter } from '../../../src/api/player-stat/route'; // Import the router
import { CachePrefix } from '../../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../../src/data/fpl/bootstrap.data';
import { FplBootstrapDataService } from '../../../src/data/types';
import { createEventCache } from '../../../src/domains/event/cache';
import { EventCache } from '../../../src/domains/event/types';
import { createPlayerCache } from '../../../src/domains/player/cache';
import { PlayerCache } from '../../../src/domains/player/types';
import { createPlayerStatCache } from '../../../src/domains/player-stat/cache';
import { PlayerStatCache } from '../../../src/domains/player-stat/types';
import { createTeamCache } from '../../../src/domains/team/cache';
import { TeamCache } from '../../../src/domains/team/types';
import { redisClient } from '../../../src/infrastructures/cache/client';
import { HTTPClient } from '../../../src/infrastructures/http';
import { createEventRepository } from '../../../src/repositories/event/repository';
import { EventRepository } from '../../../src/repositories/event/type';
import { createPlayerRepository } from '../../../src/repositories/player/repository';
import { PlayerRepository } from '../../../src/repositories/player/type';
import { createPlayerStatRepository } from '../../../src/repositories/player-stat/repository';
import { PlayerStatRepository } from '../../../src/repositories/player-stat/type';
import { createTeamRepository } from '../../../src/repositories/team/repository';
import { TeamRepository } from '../../../src/repositories/team/type';
import { createPlayerStatService } from '../../../src/services/player-stat/service';
import { PlayerStatService } from '../../../src/services/player-stat/types';
import { PlayerStat } from '../../../src/types/domain/player-stat.type';
import {
  IntegrationTestSetupResult,
  setupIntegrationTest,
  teardownIntegrationTest,
} from '../../setup/integrationTestSetup';

// Set timeouts using vi.setConfig inside beforeAll
describe('PlayerStat Routes Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let app: express.Express;
  let prisma: PrismaClient;
  let logger: Logger;
  let httpClient: HTTPClient;
  let playerStatRepository: PlayerStatRepository;
  let playerStatCache: PlayerStatCache;
  let eventRepository: EventRepository;
  let eventCache: EventCache;
  let playerStatService: PlayerStatService;
  let fplDataService: FplBootstrapDataService;
  let playerRepository: PlayerRepository;
  let playerCache: PlayerCache;
  let teamRepository: TeamRepository;
  let teamCache: TeamCache;

  const cachePrefix = CachePrefix.PLAYER_STAT;
  const eventCachePrefix = CachePrefix.EVENT;
  const playerCachePrefix = CachePrefix.PLAYER;
  const teamCachePrefix = CachePrefix.TEAM;
  const testSeason = '2425';

  beforeAll(async () => {
    // Set test timeout for this suite
    vi.setConfig({ testTimeout: 30000 });

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

    playerRepository = createPlayerRepository(prisma);
    playerCache = createPlayerCache(playerRepository, {
      keyPrefix: playerCachePrefix,
      season: testSeason,
    });

    teamRepository = createTeamRepository(prisma);
    teamCache = createTeamCache(teamRepository, {
      keyPrefix: teamCachePrefix,
      season: testSeason,
    });

    playerStatRepository = createPlayerStatRepository(prisma);
    playerStatCache = createPlayerStatCache({
      keyPrefix: cachePrefix,
      season: testSeason,
    });
    playerStatService = createPlayerStatService(
      fplDataService,
      playerStatRepository,
      playerStatCache,
      eventCache,
      playerCache,
      teamCache,
    );

    app = express();
    app.use(express.json());
    app.use('/player-stats', playerStatRouter(playerStatService));
  });

  afterAll(async () => {
    await teardownIntegrationTest(setup);
  });

  it('GET /player-stats should return all player stats within a data object', async () => {
    const res = await request(app).get('/player-stats');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
    const stats = res.body.data as PlayerStat[];
    expect(stats.length).toBeGreaterThan(0);
    expect(stats[0]).toHaveProperty('id');
    expect(stats[0]).toHaveProperty('element');
    expect(stats[0]).toHaveProperty('event');
    expect(stats[0]).toHaveProperty('minutes');
    expect(stats[0]).toHaveProperty('team');
    expect(stats[0]).toHaveProperty('elementTypeName');
  });

  it('GET /player-stats/element/:element should return the player stat within a data object', async () => {
    const syncResult = await playerStatService.syncPlayerStatsFromApi()();
    if (E.isLeft(syncResult)) {
      logger.error({ error: syncResult.left }, 'syncPlayerStatsFromApi failed in test');
    }
    expect(E.isRight(syncResult)).toBe(true);

    const dbStat = await prisma.playerStat.findFirst();
    if (!dbStat) {
      throw new Error('Could not find any player stats in the database after sync');
    }
    const targetElementId = dbStat.element;

    const res = await request(app).get(`/player-stats/element/${targetElementId}`);

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    expect(res.body).toHaveProperty('data');
    expect(res.body.data.element).toBe(targetElementId);
    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data).toHaveProperty('event');
    expect(res.body.data).toHaveProperty('team');
    expect(res.body.data).toHaveProperty('elementTypeName');
  }, 30000);

  it('GET /player-stats/element/:element should return 404 if element ID does not exist', async () => {
    const nonExistentElementId = 999999999;
    const res = await request(app).get(`/player-stats/element/${nonExistentElementId}`);

    expect(res.status).toBe(404);
  });
});
