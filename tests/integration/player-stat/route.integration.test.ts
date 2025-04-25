import { PrismaClient } from '@prisma/client';
import express from 'express';
import * as E from 'fp-ts/Either';
import { Logger } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { playerStatRouter } from '../../../src/api/player-stat/route';
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
import { createPlayerStatRepository } from '../../../src/repositories/player-stat/repository';
import { PlayerStatRepository } from '../../../src/repositories/player-stat/types';
import { createPlayerStatService } from '../../../src/services/player-stat/service';
import { PlayerStatService } from '../../../src/services/player-stat/types';
import { PlayerStat } from '../../../src/types/domain/player-stat.type';
import {
  IntegrationTestSetupResult,
  setupIntegrationTest,
  teardownIntegrationTest,
} from '../../setup/integrationTestSetup';

describe('PlayerStat Routes Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let app: express.Express;
  let prisma: PrismaClient;
  let logger: Logger;
  let httpClient: HTTPClient;
  let playerStatRepository: PlayerStatRepository;
  let playerStatCache: PlayerStatCache;
  let eventCache: EventCache;
  let playerStatService: PlayerStatService;
  let fplDataService: FplBootstrapDataService;
  let playerCache: PlayerCache;
  let teamCache: TeamCache;

  const cachePrefix = CachePrefix.PLAYER_STAT;
  const eventCachePrefix = CachePrefix.EVENT;
  const playerCachePrefix = CachePrefix.PLAYER;
  const teamCachePrefix = CachePrefix.TEAM;
  const season = '2425';

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

    eventCache = createEventCache({
      keyPrefix: eventCachePrefix,
      season: season,
    });
    playerCache = createPlayerCache({
      keyPrefix: playerCachePrefix,
      season: season,
    });
    teamCache = createTeamCache({
      keyPrefix: teamCachePrefix,
      season: season,
    });

    playerStatRepository = createPlayerStatRepository(prisma);
    playerStatCache = createPlayerStatCache({
      keyPrefix: cachePrefix,
      season: season,
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
    expect(stats[0]).toHaveProperty('elementId');
    expect(stats[0]).toHaveProperty('eventId');
    expect(stats[0]).toHaveProperty('minutes');
    expect(stats[0]).toHaveProperty('teamId');
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
    const targetElementId = dbStat.elementId;

    const res = await request(app).get(`/player-stats/element/${targetElementId}`);

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    expect(res.body).toHaveProperty('data');
    expect(res.body.data.elementId).toBe(targetElementId);
    expect(res.body.data).toHaveProperty('eventId');
    expect(res.body.data).toHaveProperty('teamId');
    expect(res.body.data).toHaveProperty('elementTypeName');
  }, 30000);

  it('GET /player-stats/element/:element should return 404 if element ID does not exist', async () => {
    const nonExistentElementId = 999999999;
    const res = await request(app).get(`/player-stats/element/${nonExistentElementId}`);

    expect(res.status).toBe(404);
  });

  it('POST /player-stats/sync should trigger synchronization and return success', async () => {
    // Clear cache and DB before testing sync specifically
    await prisma.playerStat.deleteMany({});
    const keys = await redisClient.keys(`${cachePrefix}::${season}*`);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }

    const res = await request(app).post('/player-stats/sync');

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    // The handler returns void on success, resulting in an empty body

    // Verify data was actually synced
    const statsInDb = await prisma.playerStat.findMany();
    expect(statsInDb.length).toBeGreaterThan(0);
  }, 30000);

  it('GET /player-stats/element-type/:elementType should return stats for that type', async () => {
    // Find a common element type (e.g., 2 for DEF)
    const targetElementType = 2;
    const res = await request(app).get(`/player-stats/element-type/${targetElementType}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
    const stats = res.body.data as PlayerStat[];
    expect(stats.length).toBeGreaterThan(0);
    expect(stats.every((s) => s.elementType === targetElementType)).toBe(true);
    expect(stats[0]).toHaveProperty('elementId');
  });

  it('GET /player-stats/team/:team should return stats for that team', async () => {
    // Find a common team ID (e.g., 1 for Arsenal)
    const targetTeamId = 1;
    const res = await request(app).get(`/player-stats/team/${targetTeamId}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
    const stats = res.body.data as PlayerStat[];
    expect(stats.length).toBeGreaterThan(0);
    expect(stats.every((s) => s.teamId === targetTeamId)).toBe(true);
    expect(stats[0]).toHaveProperty('elementId');
  });
});
