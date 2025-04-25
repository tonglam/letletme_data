import { PrismaClient } from '@prisma/client';
import express, { Express } from 'express';
import { Logger } from 'pino';
import { formatYYYYMMDD } from 'src/utils/date.util';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { playerValueRouter } from '../../../src/api/player-value/route';
import { CachePrefix } from '../../../src/configs/cache/cache.config';
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
import { createPlayerValueRepository } from '../../../src/repositories/player-value/repository';
import { PlayerValueRepository } from '../../../src/repositories/player-value/types';
import { createPlayerValueService } from '../../../src/services/player-value/service';
import { PlayerValueService } from '../../../src/services/player-value/types';
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
  let eventCache: EventCache;
  let teamCache: TeamCache;
  let playerCache: PlayerCache;

  const cachePrefix = CachePrefix.PLAYER_VALUE;
  const eventCachePrefix = CachePrefix.EVENT;
  const teamCachePrefix = CachePrefix.TEAM;
  const playerCachePrefix = CachePrefix.PLAYER;
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

    teamCache = createTeamCache({
      keyPrefix: teamCachePrefix,
      season: season,
    });

    playerCache = createPlayerCache({
      keyPrefix: playerCachePrefix,
      season: season,
    });

    playerValueRepository = createPlayerValueRepository(prisma);
    playerValueCache = createPlayerValueCache({
      keyPrefix: cachePrefix,
      season: season,
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
      expect(values[0]).toHaveProperty('elementId');
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
    const targetElementId = dbValue.elementId;

    const res = await request(app).get(`/player-values/element/${targetElementId}`);

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    const valueData = res.body.data[0];
    expect(valueData.elementId).toBe(targetElementId);
    expect(valueData).toHaveProperty('value');
    expect(valueData).toHaveProperty('lastValue');
    expect(valueData).toHaveProperty('changeType');
  });

  it('GET /player-values/team/:team should return values for players of that team', async () => {
    const targetTeamId = 1; // Example: Arsenal
    const res = await request(app).get(`/player-values/team/${targetTeamId}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
    const values = res.body.data;
    if (values.length > 0) {
      // Need to verify team association indirectly or add team info to service response
      // For now, just check the structure
      expect(values[0]).toHaveProperty('elementId');
      expect(values[0]).toHaveProperty('value');
      expect(values[0]).toHaveProperty('changeDate');
    } else {
      console.warn(
        `[Test Warning] No player values found for team ${targetTeamId} during test run.`,
      );
    }
  });

  it('GET /player-values/sync should trigger synchronization and return success', async () => {
    // Clear cache and DB before testing sync specifically
    await prisma.playerValue.deleteMany({});
    const valueKeys = await redisClient.keys(`${cachePrefix}::${season}*`);
    if (valueKeys.length > 0) await redisClient.del(valueKeys);

    const res = await request(app).get('/player-values/sync');

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    // The handler returns void on success, resulting in an empty body

    // Verify data was actually synced
    const valuesInDb = await prisma.playerValue.findMany();
    expect(valuesInDb.length).toBeGreaterThan(0);
  });
});
