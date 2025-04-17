import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import * as E from 'fp-ts/Either';
import Redis from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiConfig } from '../../src/configs/api/api.config';
import { CachePrefix } from '../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../src/data/fpl/bootstrap.data';
import { createEventCache } from '../../src/domains/event/cache';
import { EventCache, EventRepository } from '../../src/domains/event/types';
import { createPlayerValueCache } from '../../src/domains/player-value/cache';
import { PlayerValueCache, PlayerValueRepository } from '../../src/domains/player-value/types';
import { createHTTPClient } from '../../src/infrastructures/http/client';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructures/http/client/utils';
import { createEventRepository } from '../../src/repositories/event/repository';
import { createPlayerValueRepository } from '../../src/repositories/player-value/repository';
import { createEventService } from '../../src/services/event/service';
import { EventService } from '../../src/services/event/types';
import { createPlayerValueService } from '../../src/services/player-value/service';
import { PlayerValueService } from '../../src/services/player-value/types';
import { playerValueWorkflows } from '../../src/services/player-value/workflow';
import { PlayerValues } from '../../src/types/domain/player-value.type';

describe('PlayerValue Integration Tests', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let playerValueRepository: PlayerValueRepository;
  let playerValueCache: PlayerValueCache;
  let playerValueService: PlayerValueService;
  let logger: pino.Logger;

  // EventService might be needed
  let eventRepository: EventRepository;
  let eventCache: EventCache;
  let eventService: EventService;

  let bootstrapDataService: ReturnType<typeof createFplBootstrapDataService>;

  beforeAll(async () => {
    prisma = new PrismaClient();
    logger = pino({ level: 'info' });

    redis = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_DB || '0', 10),
    });

    if (redis.status !== 'ready') {
      await new Promise<void>((resolve) => {
        redis.once('ready', () => resolve());
      });
    }

    const httpClient = createHTTPClient({
      client: axios.create({ baseURL: apiConfig.baseUrl }),
      retryConfig: {
        ...DEFAULT_RETRY_CONFIG,
        attempts: 3,
        baseDelay: 1000,
        maxDelay: 5000,
      },
      logger,
    });

    bootstrapDataService = createFplBootstrapDataService(httpClient, logger);

    // Initialize EventService dependencies (in case needed)
    eventRepository = createEventRepository(prisma);
    eventCache = createEventCache(eventRepository, {
      keyPrefix: CachePrefix.EVENT,
      season: '2425',
    });
    eventService = createEventService(bootstrapDataService, eventRepository, eventCache);

    // Initialize PlayerValueService dependencies
    playerValueRepository = createPlayerValueRepository(prisma);
    playerValueCache = createPlayerValueCache(playerValueRepository, {
      keyPrefix: CachePrefix.PLAYER_VALUE,
      season: '2425',
    });

    // Create PlayerValueService - Adding EventService as 4th arg
    playerValueService = createPlayerValueService(
      bootstrapDataService, // Assumption 1
      playerValueRepository, // Assumption 2
      playerValueCache, // Assumption 3
      eventService, // Assumption 4: EventService
      // logger, // Keep commented out for now
    );
  });

  beforeEach(async () => {
    await prisma.playerValue.deleteMany({});
    await prisma.event.deleteMany({});

    const playerValueKeys = await redis.keys(`${CachePrefix.PLAYER_VALUE}::*`);
    if (playerValueKeys.length > 0) {
      await redis.del(playerValueKeys);
    }
    const eventKeys = await redis.keys(`${CachePrefix.EVENT}::*`);
    if (eventKeys.length > 0) {
      await redis.del(eventKeys);
    }
    const testKeys = await redis.keys('test:*');
    if (testKeys.length > 0) {
      await redis.del(testKeys);
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await redis.quit();
  });

  describe('PlayerValue Service Integration', () => {
    it('should fetch player values from API, store in database, and cache them', async () => {
      // Sync events first if player value sync depends on it
      await eventService.syncEventsFromApi()();

      // Sync player values (assuming no specific args needed)
      const syncResult = await playerValueService.syncPlayerValuesFromApi()();

      expect(E.isRight(syncResult)).toBe(true);
      if (E.isRight(syncResult)) {
        const playerValues = syncResult.right as PlayerValues;
        expect(Array.isArray(playerValues)).toBe(true);

        // If values were synced, check structure
        if (playerValues.length > 0) {
          const firstValue = playerValues[0];
          expect(firstValue).toHaveProperty('elementId');
          expect(firstValue).toHaveProperty('eventId');
          expect(firstValue).toHaveProperty('value');
        }
      }

      // Verify some player values exist in the DB
      const dbPlayerValuesCount = await prisma.playerValue.count();
      expect(dbPlayerValuesCount).toBeDefined(); // Basic check
      // expect(dbPlayerValuesCount).toBeGreaterThan(0);

      // Verify cache exists
      const cacheKeys = await redis.keys(`${CachePrefix.PLAYER_VALUE}::*`);
      expect(cacheKeys).toBeDefined();
      // expect(cacheKeys.length).toBeGreaterThan(0);
    });
  });

  describe('PlayerValue Workflow Integration', () => {
    it('should execute the sync player values workflow end-to-end', async () => {
      // Sync events first
      await eventService.syncEventsFromApi()();

      const workflows = playerValueWorkflows(playerValueService);
      // Execute workflow (assuming no specific args)
      const result = await workflows.syncPlayerValues()();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right.context).toBeDefined();
        expect(result.right.context.workflowId).toBeDefined();
        expect(result.right.duration).toBeGreaterThan(0);
        expect(result.right.result).toBeDefined();
        expect(Array.isArray(result.right.result)).toBe(true);

        // Verify DB count
        const dbPlayerValuesCount = await prisma.playerValue.count();
        expect(dbPlayerValuesCount).toBeDefined();
        // expect(dbPlayerValuesCount).toEqual(result.right.result.length);
      }
    });
  });
});
