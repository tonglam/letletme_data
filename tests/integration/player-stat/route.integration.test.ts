import { PrismaClient } from '@prisma/client';
import express from 'express';
import * as E from 'fp-ts/Either';
import { Logger } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Setup

// Specific imports
import { playerStatRouter } from '../../../src/api/player-stat/player-stat.route'; // Import the router
import { CachePrefix } from '../../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../../src/data/fpl/bootstrap.data';
import { FplBootstrapDataService } from '../../../src/data/types';
import { createEventCache } from '../../../src/domains/event/cache';
import { EventCache, EventRepository } from '../../../src/domains/event/types';
import { createPlayerStatCache } from '../../../src/domains/player-stat/cache';
import { PlayerStatCache, PlayerStatRepository } from '../../../src/domains/player-stat/types';
import { redisClient } from '../../../src/infrastructures/cache/client';
import { HTTPClient } from '../../../src/infrastructures/http';
import { createEventRepository } from '../../../src/repositories/event/repository';
import { createPlayerStatRepository } from '../../../src/repositories/player-stat/repository';
import { createEventService } from '../../../src/services/event/service';
import { EventService } from '../../../src/services/event/types';
import { createPlayerStatService } from '../../../src/services/player-stat/service';
import { PlayerStatService } from '../../../src/services/player-stat/types';
import { PlayerStat, PlayerStatId } from '../../../src/types/domain/player-stat.type';
// Event service dependency
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
  let eventService: EventService;
  let playerStatService: PlayerStatService;
  let fplDataService: FplBootstrapDataService;

  const cachePrefix = CachePrefix.PLAYER_STAT;
  const eventCachePrefix = CachePrefix.EVENT;
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
    eventService = createEventService(fplDataService, eventRepository, eventCache);

    playerStatRepository = createPlayerStatRepository(prisma);
    playerStatCache = createPlayerStatCache(playerStatRepository, {
      keyPrefix: cachePrefix,
      season: testSeason,
    });
    playerStatService = createPlayerStatService(
      fplDataService,
      playerStatRepository,
      playerStatCache,
      eventService,
    );

    // Create Express app and mount only the playerStat router
    app = express();
    app.use(express.json());
    app.use('/player-stats', playerStatRouter(playerStatService)); // Mount router
  });

  beforeEach(async () => {
    await prisma.playerStat.deleteMany({});
    await prisma.event.deleteMany({}); // Clear events too

    // Use shared client for cleanup
    const statKeys = await redisClient.keys(`${cachePrefix}::${testSeason}*`);
    if (statKeys.length > 0) {
      await redisClient.del(statKeys);
    }
    const eventKeys = await redisClient.keys(`${eventCachePrefix}::${testSeason}*`);
    if (eventKeys.length > 0) {
      await redisClient.del(eventKeys);
    }
    // Ensure data exists for GET requests by syncing both services
    await eventService.syncEventsFromApi()();
    await playerStatService.syncPlayerStatsFromApi()();
  }, 20000); // Timeout set to 20000ms

  afterAll(async () => {
    await teardownIntegrationTest(setup);
  });

  // --- Test Cases ---

  it('GET /player-stats should return all player stats within a data object', async () => {
    const res = await request(app).get('/player-stats');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
    const stats = res.body.data as PlayerStat[];
    expect(stats.length).toBeGreaterThan(0);
    expect(stats[0]).toHaveProperty('id');
    expect(stats[0]).toHaveProperty('elementId');
    expect(stats[0]).toHaveProperty('eventId');
    expect(stats[0]).toHaveProperty('minutes');
  });

  it('GET /player-stats/:id should return the player stat within a data object', async () => {
    // Sync first to ensure data exists in the DB
    const syncResult = await playerStatService.syncPlayerStatsFromApi()();
    // Log the error if sync fails
    if (E.isLeft(syncResult)) {
      logger.error({ error: syncResult.left }, 'syncPlayerStatsFromApi failed in test');
    }
    expect(E.isRight(syncResult)).toBe(true);

    // Fetch one record directly from the database to get a valid ID
    const dbStat = await prisma.playerStat.findFirst();
    if (!dbStat) {
      throw new Error('Could not find any player stats in the database after sync');
    }
    const targetStatId = dbStat.id as PlayerStatId; // Cast the db ID to PlayerStatId

    const res = await request(app).get(`/player-stats/${targetStatId}`);

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    expect(res.body).toHaveProperty('data');
    expect(res.body.data.id).toBe(targetStatId);
    expect(res.body.data).toHaveProperty('elementId');
    expect(res.body.data).toHaveProperty('eventId');
  }, 30000);

  it('GET /player-stats/:id should return 404 if player stat ID does not exist', async () => {
    const nonExistentStatId = 999999999 as PlayerStatId;
    const res = await request(app).get(`/player-stats/${nonExistentStatId}`);

    expect(res.status).toBe(404);
  });
});
