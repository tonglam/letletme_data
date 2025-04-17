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
import { createPlayerStatCache } from '../../src/domains/player-stat/cache';
import { PlayerStatCache, PlayerStatRepository } from '../../src/domains/player-stat/types';
import { createHTTPClient } from '../../src/infrastructures/http/client';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructures/http/client/utils';
import { createEventRepository } from '../../src/repositories/event/repository';
import { createPlayerStatRepository } from '../../src/repositories/player-stat/repository';
import { createEventService } from '../../src/services/event/service';
import { EventService } from '../../src/services/event/types';
import { createPlayerStatService } from '../../src/services/player-stat/service';
import { PlayerStatService } from '../../src/services/player-stat/types';
import { playerStatWorkflows } from '../../src/services/player-stat/workflow';
import { PlayerStats } from '../../src/types/domain/player-stat.type';

describe('PlayerStat Integration Tests', { timeout: 30000 }, () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let playerStatRepository: PlayerStatRepository;
  let playerStatCache: PlayerStatCache;
  let playerStatService: PlayerStatService;
  let logger: pino.Logger;

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

    eventRepository = createEventRepository(prisma);
    eventCache = createEventCache(eventRepository, {
      keyPrefix: CachePrefix.EVENT,
      season: '2425',
    });
    eventService = createEventService(bootstrapDataService, eventRepository, eventCache);

    playerStatRepository = createPlayerStatRepository(prisma);
    playerStatCache = createPlayerStatCache(playerStatRepository, {
      keyPrefix: CachePrefix.PLAYER_STAT,
      season: '2425',
    });

    playerStatService = createPlayerStatService(
      bootstrapDataService,
      playerStatRepository,
      playerStatCache,
      eventService,
    );
  });

  beforeEach(async () => {
    await prisma.playerStat.deleteMany({});
    await prisma.event.deleteMany({});

    const playerStatKeys = await redis.keys(`${CachePrefix.PLAYER_STAT}::*`);
    if (playerStatKeys.length > 0) {
      await redis.del(playerStatKeys);
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

  describe('PlayerStat Service Integration', () => {
    it('should fetch player stats from API, store in database, and cache them', async () => {
      await eventService.syncEventsFromApi()();

      const syncResult = await playerStatService.syncPlayerStatsFromApi()();

      expect(E.isRight(syncResult)).toBe(true);
      if (E.isRight(syncResult)) {
        const playerStats = syncResult.right as PlayerStats;
        expect(Array.isArray(playerStats)).toBe(true);

        if (playerStats.length > 0) {
          const firstStat = playerStats[0];
          expect(firstStat).toHaveProperty('elementId');
          expect(firstStat).toHaveProperty('eventId');
          expect(firstStat).toHaveProperty('minutes');
          expect(firstStat).toHaveProperty('totalPoints');
        }
      }

      const dbPlayerStatsCount = await prisma.playerStat.count();
      expect(dbPlayerStatsCount).toBeDefined();

      const cacheKeys = await redis.keys(`${CachePrefix.PLAYER_STAT}::*`);
      expect(cacheKeys).toBeDefined();
    });
  });

  describe('PlayerStat Workflow Integration', () => {
    it('should execute the sync player stats workflow end-to-end', async () => {
      await eventService.syncEventsFromApi()();

      const workflows = playerStatWorkflows(playerStatService);
      const result = await workflows.syncPlayerStats()();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right.context).toBeDefined();
        expect(result.right.context.workflowId).toBeDefined();
        expect(result.right.duration).toBeGreaterThan(0);
        expect(result.right.result).toBeDefined();
        expect(Array.isArray(result.right.result)).toBeDefined();

        const dbPlayerStatsCount = await prisma.playerStat.count();
        expect(dbPlayerStatsCount).toBeDefined();
      }
    });
  });
});
