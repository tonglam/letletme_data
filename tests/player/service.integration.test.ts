import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { CachePrefix } from '../../src/config/cache/cache.config';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { createPlayerCache } from '../../src/domain/player/cache';
import { createPlayerRepository } from '../../src/domain/player/repository';
import { createRedisCache } from '../../src/infrastructure/cache/redis-cache';
import { prisma } from '../../src/infrastructure/db/prisma';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructure/http/client/utils';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import { createPlayerService } from '../../src/service/player';
import { getCurrentSeason } from '../../src/types/base.type';
import { ServiceError } from '../../src/types/error.type';
import type { Player, PlayerId } from '../../src/types/player.type';
import { toDomainPlayer } from '../../src/types/player.type';

describe('Player Service Integration Tests', () => {
  const TEST_TIMEOUT = 30000;

  // Test-specific cache keys
  const TEST_CACHE_PREFIX = CachePrefix.PLAYER;
  const testCacheKey = `${TEST_CACHE_PREFIX}::${getCurrentSeason()}`;

  // Service dependencies with optimized retry config
  const fplClient = createFPLClient({
    retryConfig: {
      ...DEFAULT_RETRY_CONFIG,
      attempts: 3,
      baseDelay: 500,
      maxDelay: 2000,
    },
  });
  const bootstrapApi = createBootstrapApiAdapter(fplClient);
  const playerRepository = createPlayerRepository(prisma);

  // Create Redis cache with remote configuration
  const redisCache = createRedisCache<Player>({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    db: Number(process.env.REDIS_DB ?? 0),
  });

  const playerCache = createPlayerCache(redisCache, {
    getOne: async (id: number) => {
      const result = await playerRepository.findById(id as PlayerId)();
      if (E.isRight(result) && result.right) {
        return toDomainPlayer(result.right);
      }
      return null;
    },
    getAll: async () => {
      const result = await playerRepository.findAll()();
      if (E.isRight(result)) {
        return result.right.map(toDomainPlayer);
      }
      return [];
    },
  });

  const playerService = createPlayerService(bootstrapApi, playerRepository, playerCache);

  beforeAll(async () => {
    try {
      // Wait for Redis connection
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Clear existing data
      await prisma.player.deleteMany();

      // Clear test-specific cache keys
      const multi = redisCache.client.multi();
      multi.del(testCacheKey);
      await multi.exec();

      // Sync players from API
      await pipe(
        playerService.syncPlayersFromApi(),
        TE.fold<ServiceError, readonly Player[], void>(
          (error) => {
            console.error('Failed to sync players:', error);
            return T.of(undefined);
          },
          () => T.of(void (async () => {})()),
        ),
      )();
    } catch (error) {
      console.error('Error in beforeAll:', error);
      throw error;
    }
  }, TEST_TIMEOUT);

  afterAll(async () => {
    try {
      // Close connections
      await redisCache.client.quit();
      await prisma.$disconnect();
    } catch (error) {
      console.error('Error in afterAll:', error);
      throw error;
    }
  });

  describe('Service Setup', () => {
    it('should create service with proper interface', () => {
      expect(playerService).toBeDefined();
      expect(playerService.getPlayers).toBeDefined();
      expect(playerService.getPlayer).toBeDefined();
      expect(playerService.savePlayers).toBeDefined();
      expect(playerService.syncPlayersFromApi).toBeDefined();
      expect(playerService.workflows).toBeDefined();
      expect(playerService.workflows.syncPlayers).toBeDefined();
    });
  });

  describe('Player Retrieval', () => {
    it(
      'should get all players',
      async () => {
        const result = await pipe(
          playerService.getPlayers(),
          TE.fold<ServiceError, readonly Player[], readonly Player[]>(
            () => T.of([]),
            (players) => T.of(players),
          ),
        )();

        expect(result.length).toBeGreaterThan(0);
        expect(result[0]).toMatchObject({
          id: expect.any(Number),
          elementCode: expect.any(Number),
          price: expect.any(Number),
          startPrice: expect.any(Number),
          elementType: expect.any(String),
          webName: expect.any(String),
          teamId: expect.any(Number),
        });
      },
      TEST_TIMEOUT,
    );

    it(
      'should get player by id',
      async () => {
        // First get all players to find a valid ID
        const players = await pipe(
          playerService.getPlayers(),
          TE.fold<ServiceError, readonly Player[], readonly Player[]>(
            () => T.of([]),
            (players) => T.of(players),
          ),
        )();

        expect(players.length).toBeGreaterThan(0);
        const testPlayer = players[0];

        const result = await pipe(
          playerService.getPlayer(testPlayer.id),
          TE.map((player: Player | null): O.Option<Player> => O.fromNullable(player)),
          TE.fold<ServiceError, O.Option<Player>, O.Option<Player>>(
            () => T.of(O.none),
            (playerOption) => T.of(playerOption),
          ),
        )();

        expect(O.isSome(result)).toBe(true);
        if (O.isSome(result)) {
          expect(result.value).toMatchObject({
            id: testPlayer.id,
            elementCode: expect.any(Number),
            price: expect.any(Number),
            startPrice: expect.any(Number),
            elementType: expect.any(String),
            webName: expect.any(String),
            teamId: expect.any(Number),
          });
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should handle non-existent player id',
      async () => {
        const nonExistentId = 9999 as PlayerId;
        const result = await pipe(
          playerService.getPlayer(nonExistentId),
          TE.map((player: Player | null): O.Option<Player> => O.fromNullable(player)),
          TE.fold<ServiceError, O.Option<Player>, O.Option<Player>>(
            () => T.of(O.none),
            (playerOption) => T.of(playerOption),
          ),
        )();

        expect(O.isNone(result)).toBe(true);
      },
      TEST_TIMEOUT,
    );
  });

  describe('Player Creation', () => {
    it(
      'should save players',
      async () => {
        // First get all players
        const existingPlayers = await pipe(
          playerService.getPlayers(),
          TE.fold<ServiceError, readonly Player[], readonly Player[]>(
            () => T.of([]),
            (players) => T.of(players),
          ),
        )();

        expect(existingPlayers.length).toBeGreaterThan(0);

        // Create new players with different IDs
        const newPlayers = existingPlayers.slice(0, 2).map((player) => ({
          ...player,
          id: (player.id + 1000) as PlayerId,
        }));

        const result = await pipe(
          playerService.savePlayers(newPlayers),
          TE.fold<ServiceError, readonly Player[], readonly Player[]>(
            () => T.of([]),
            (players) => T.of(players),
          ),
        )();

        expect(result.length).toBe(newPlayers.length);
        expect(result[0]).toMatchObject({
          id: newPlayers[0].id,
          elementCode: expect.any(Number),
          price: expect.any(Number),
          startPrice: expect.any(Number),
          elementType: expect.any(String),
          webName: expect.any(String),
          teamId: expect.any(Number),
        });
      },
      TEST_TIMEOUT,
    );
  });
});
