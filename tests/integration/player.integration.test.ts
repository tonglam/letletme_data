import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import * as E from 'fp-ts/Either';
import Redis from 'ioredis';
import pino from 'pino';

import { apiConfig } from '../../src/configs/api/api.config';
import { CachePrefix } from '../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../src/data/fpl/bootstrap.data';
import { createPlayerCache } from '../../src/domains/player/cache';
import { PlayerCache, PlayerRepository } from '../../src/domains/player/types';
import { createHTTPClient } from '../../src/infrastructures/http/client';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructures/http/client/utils';
import { createPlayerRepository } from '../../src/repositories/player/repository';
import { createPlayerService } from '../../src/services/player/service';
import { PlayerService } from '../../src/services/player/types';
import { playerWorkflows } from '../../src/services/player/workflow';
import { Players } from '../../src/types/domain/player.type';

describe('Player Integration Tests', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let playerRepository: PlayerRepository;
  let playerCache: PlayerCache;
  let playerService: PlayerService;
  let logger: pino.Logger;

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

    const bootstrapDataService = createFplBootstrapDataService(httpClient, logger);
    playerRepository = createPlayerRepository(prisma);
    playerCache = createPlayerCache(playerRepository, {
      keyPrefix: CachePrefix.PLAYER,
      season: '2425',
    });
    playerService = createPlayerService(bootstrapDataService, playerRepository, playerCache);
  });

  beforeEach(async () => {
    await prisma.player.deleteMany({});
    const standardKeys = await redis.keys(`${CachePrefix.PLAYER}::*`);
    if (standardKeys.length > 0) {
      await redis.del(standardKeys);
    }
    const testKeys = await redis.keys(`test:${CachePrefix.PLAYER}::*`);
    if (testKeys.length > 0) {
      await redis.del(testKeys);
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await redis.quit();
  });

  describe('Player Service Integration', () => {
    it('should fetch players from API, store in database, and cache them', async () => {
      const syncResult = await playerService.syncPlayersFromApi()();

      expect(E.isRight(syncResult)).toBe(true);
      if (E.isRight(syncResult)) {
        const players = syncResult.right as Players;
        expect(players.length).toBeGreaterThan(0);

        const firstPlayer = players[0];
        expect(firstPlayer).toHaveProperty('id');
        expect(firstPlayer).toHaveProperty('firstName');
        expect(firstPlayer).toHaveProperty('secondName');
        expect(firstPlayer).toHaveProperty('elementCode');
      }

      const dbPlayers = await prisma.player.findMany();
      expect(dbPlayers.length).toBeGreaterThan(0);

      const cacheKey = `${CachePrefix.PLAYER}::2425`;
      const keyExists = await redis.exists(cacheKey);
      expect(keyExists).toBe(1);
    });

    it('should get player by ID after syncing', async () => {
      const syncResult = await playerService.syncPlayersFromApi()();

      if (E.isRight(syncResult)) {
        const players = syncResult.right as Players;
        if (players.length > 0) {
          const firstPlayerId = players[0].id;
          const playerResult = await playerService.getPlayer(firstPlayerId)();

          expect(E.isRight(playerResult)).toBe(true);
          if (E.isRight(playerResult) && playerResult.right) {
            expect(playerResult.right.id).toEqual(firstPlayerId);
          }
        }
      }
    });
  });

  describe('Player Workflow Integration', () => {
    it('should execute the sync players workflow end-to-end', async () => {
      const workflows = playerWorkflows(playerService);
      const result = await workflows.syncPlayers()();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right.context).toBeDefined();
        expect(result.right.context.workflowId).toBeDefined();
        expect(result.right.duration).toBeGreaterThan(0);
        expect(result.right.result).toBeDefined();
        expect(result.right.result.length).toBeGreaterThan(0);

        const dbPlayers = await prisma.player.findMany();
        expect(dbPlayers.length).toEqual(result.right.result.length);
      }
    });
  });
});
