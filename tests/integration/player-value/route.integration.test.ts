import { PrismaClient } from '@prisma/client';
import express, { Express } from 'express';
import * as E from 'fp-ts/Either';
import { Logger } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Setup
import { redisClient } from '../../../src/infrastructures/cache/client';
import {
  IntegrationTestSetupResult,
  setupIntegrationTest,
  teardownIntegrationTest,
} from '../../setup/integrationTestSetup';

// Specific imports
import { playerValueRouter } from '../../../src/api/routes/player-value.route'; // Import the router
import { CachePrefix } from '../../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../../src/data/fpl/bootstrap.data';
import { FplBootstrapDataService } from '../../../src/data/types';
import { createPlayerValueCache } from '../../../src/domains/player-value/cache';
import { PlayerValueCache, PlayerValueRepository } from '../../../src/domains/player-value/types';
import { HTTPClient } from '../../../src/infrastructures/http/client';
import { createPlayerValueRepository } from '../../../src/repositories/player-value/repository';
import { createPlayerValueService } from '../../../src/services/player-value/service';
import { PlayerValueService } from '../../../src/services/player-value/types';
import { PlayerValue, PlayerValueId } from '../../../src/types/domain/player-value.type';
// Event service dependency
import { createEventCache } from '../../../src/domains/event/cache';
import { EventCache, EventRepository } from '../../../src/domains/event/types';
import { createEventRepository } from '../../../src/repositories/event/repository';
import { createEventService } from '../../../src/services/event/service';
import { EventService } from '../../../src/services/event/types';

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

  const cachePrefix = CachePrefix.PLAYER_VALUE;
  const eventCachePrefix = CachePrefix.EVENT;
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

    playerValueRepository = createPlayerValueRepository(prisma);
    playerValueCache = createPlayerValueCache(playerValueRepository, {
      keyPrefix: cachePrefix,
      season: testSeason,
    });
    playerValueService = createPlayerValueService(
      fplDataService,
      playerValueRepository,
      playerValueCache,
      eventService,
    );

    // Create Express app and mount only the playerValue router
    app = express();
    app.use(express.json());
    app.use('/player-values', playerValueRouter(playerValueService)); // Mount router
  });

  beforeEach(async () => {
    await prisma.playerValue.deleteMany({});
    await prisma.event.deleteMany({}); // Clear events too
    const valueKeys = await redisClient.keys(`${cachePrefix}::${testSeason}*`);
    if (valueKeys.length > 0) {
      await redisClient.del(valueKeys);
    }
    const eventKeys = await redisClient.keys(`${eventCachePrefix}::${testSeason}*`);
    if (eventKeys.length > 0) {
      await redisClient.del(eventKeys);
    }
    // Ensure data exists for GET requests by syncing both services
    await eventService.syncEventsFromApi()();
    await playerValueService.syncPlayerValuesFromApi()();
  });

  afterAll(async () => {
    await teardownIntegrationTest(setup);
  });

  // --- Test Cases ---

  it('GET /player-values should return all player values within a data object', async () => {
    const res = await request(app).get('/player-values');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
    const values = res.body.data as PlayerValue[];
    expect(values.length).toBeGreaterThan(0);
    expect(values[0]).toHaveProperty('id');
    expect(values[0]).toHaveProperty('elementId');
    expect(values[0]).toHaveProperty('eventId');
    expect(values[0]).toHaveProperty('value');
  });

  it('GET /player-values/:id should return the player value within a data object', async () => {
    const allValuesResult = await playerValueService.getPlayerValues()();
    let targetValueId: PlayerValueId | null = null;
    if (E.isRight(allValuesResult) && allValuesResult.right && allValuesResult.right.length > 0) {
      targetValueId = allValuesResult.right[0].id;
    } else {
      throw new Error('Could not retrieve player values to get an ID for testing');
    }

    const res = await request(app).get(`/player-values/${targetValueId}`);

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    expect(res.body).toHaveProperty('data');
    expect(res.body.data.id).toBe(targetValueId);
    expect(res.body.data).toHaveProperty('elementId');
    expect(res.body.data).toHaveProperty('eventId');
  });

  it('GET /player-values/:id should return 404 if player value ID does not exist', async () => {
    const nonExistentValueId = 999999999 as PlayerValueId;
    const res = await request(app).get(`/player-values/${nonExistentValueId}`);

    expect(res.status).toBe(404);
  });
});
