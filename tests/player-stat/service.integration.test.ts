import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { CachePrefix } from '../../src/config/cache/cache.config';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { createEventCache } from '../../src/domain/event/cache';
import { createEventOperations } from '../../src/domain/event/operation';
import { createEventRepository } from '../../src/domain/event/repository';
import { createPlayerStatCache } from '../../src/domain/player-stat/cache';
import { createPlayerStatRepository } from '../../src/domain/player-stat/repository';
import { createRedisCache } from '../../src/infrastructure/cache/redis-cache';
import { prisma } from '../../src/infrastructure/db/prisma';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructure/http/client/utils';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import { createPlayerStatService } from '../../src/service/player-stat';
import { getCurrentSeason } from '../../src/types/base.type';
import { ServiceError } from '../../src/types/error.type';
import type { Event } from '../../src/types/event.type';
import { toDomainEvent, validateEventId } from '../../src/types/event.type';
import type { PlayerStat, PlayerStatId } from '../../src/types/player-stat.type';
import { toDomainPlayerStat } from '../../src/types/player-stat.type';

describe('Player Stat Service Integration Tests', () => {
  const TEST_TIMEOUT = 30000;

  // Test-specific cache keys
  const TEST_CACHE_PREFIX = CachePrefix.PLAYER_STAT;
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
  const playerStatRepository = createPlayerStatRepository(prisma);
  const eventRepository = createEventRepository(prisma);

  // Create Redis caches with remote configuration
  const eventRedisCache = createRedisCache<Event>({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    db: Number(process.env.REDIS_DB ?? 0),
  });

  const eventCache = createEventCache(eventRedisCache, {
    getOne: async (id: number) => {
      const eventId = pipe(
        id,
        validateEventId,
        E.getOrElseW(() => {
          throw new Error(`Invalid event ID: ${id}`);
        }),
      );
      const result = await eventRepository.findById(eventId)();
      if (E.isRight(result) && result.right) {
        return toDomainEvent(result.right);
      }
      return null;
    },
    getAll: async () => {
      const result = await eventRepository.findAll()();
      if (E.isRight(result)) {
        return result.right.map(toDomainEvent);
      }
      return [];
    },
    getCurrent: async () => {
      const result = await eventRepository.findCurrent()();
      if (E.isRight(result) && result.right) {
        return toDomainEvent(result.right);
      }
      return null;
    },
    getNext: async () => {
      const result = await eventRepository.findNext()();
      if (E.isRight(result) && result.right) {
        return toDomainEvent(result.right);
      }
      return null;
    },
  });

  const eventOperations = createEventOperations(eventRepository, eventCache);

  const playerStatRedisCache = createRedisCache<PlayerStat>({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    db: Number(process.env.REDIS_DB ?? 0),
  });

  const playerStatCache = createPlayerStatCache(playerStatRedisCache, {
    getOneByEvent: async (id: number, eventId: number) => {
      const result = await playerStatRepository.findById(`${id}_${eventId}` as PlayerStatId)();
      if (E.isRight(result) && result.right) {
        return toDomainPlayerStat(result.right);
      }
      return null;
    },
    getAllByEvent: async (eventId: number) => {
      const result = await playerStatRepository.findByEventId(eventId)();
      if (E.isRight(result)) {
        return result.right.map(toDomainPlayerStat);
      }
      return [];
    },
  });

  const playerStatService = createPlayerStatService(
    bootstrapApi,
    playerStatRepository,
    eventOperations,
    playerStatCache,
  );

  beforeAll(async () => {
    try {
      // Wait for Redis connection
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Clear existing data
      await prisma.playerStat.deleteMany();

      // Clear test-specific cache keys
      const multi = playerStatRedisCache.client.multi();
      multi.del(testCacheKey);
      await multi.exec();

      // Sync player stats from API
      await pipe(
        playerStatService.syncPlayerStatsFromApi(),
        TE.fold<ServiceError, readonly PlayerStat[], void>(
          (error) => {
            console.error('Failed to sync player stats:', error);
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
      await playerStatRedisCache.client.quit();
      await eventRedisCache.client.quit();
      await prisma.$disconnect();
    } catch (error) {
      console.error('Error in afterAll:', error);
      throw error;
    }
  });

  describe('Service Setup', () => {
    it('should create service with proper interface', () => {
      expect(playerStatService).toBeDefined();
      expect(playerStatService.getPlayerStats).toBeDefined();
      expect(playerStatService.getPlayerStat).toBeDefined();
      expect(playerStatService.savePlayerStats).toBeDefined();
      expect(playerStatService.syncPlayerStatsFromApi).toBeDefined();
      expect(playerStatService.workflows).toBeDefined();
      expect(playerStatService.workflows.syncPlayerStats).toBeDefined();
    });
  });

  describe('Player Stat Retrieval', () => {
    it(
      'should get all player stats',
      async () => {
        const result = await pipe(
          playerStatService.getPlayerStats(),
          TE.fold<ServiceError, readonly PlayerStat[], readonly PlayerStat[]>(
            () => T.of([]),
            (stats) => T.of(stats),
          ),
        )();

        expect(result.length).toBeGreaterThan(0);
        expect(result[0]).toMatchObject({
          id: expect.any(String),
          eventId: expect.any(Number),
          elementId: expect.any(Number),
          teamId: expect.any(Number),
          form: expect.any(Number),
          influence: expect.any(Number),
          creativity: expect.any(Number),
          threat: expect.any(Number),
          ictIndex: expect.any(Number),
        });
      },
      TEST_TIMEOUT,
    );

    it(
      'should get player stat by id',
      async () => {
        // First get all player stats to find a valid ID
        const stats = await pipe(
          playerStatService.getPlayerStats(),
          TE.fold<ServiceError, readonly PlayerStat[], readonly PlayerStat[]>(
            () => T.of([]),
            (stats) => T.of(stats),
          ),
        )();

        expect(stats.length).toBeGreaterThan(0);
        const testStat = stats[0];

        const result = await pipe(
          playerStatService.getPlayerStat(testStat.id),
          TE.map((stat: PlayerStat | null): O.Option<PlayerStat> => O.fromNullable(stat)),
          TE.fold<ServiceError, O.Option<PlayerStat>, O.Option<PlayerStat>>(
            () => T.of(O.none),
            (statOption) => T.of(statOption),
          ),
        )();

        expect(O.isSome(result)).toBe(true);
        if (O.isSome(result)) {
          expect(result.value).toMatchObject({
            id: testStat.id,
            eventId: expect.any(Number),
            elementId: expect.any(Number),
            teamId: expect.any(Number),
            form: expect.any(Number),
            influence: expect.any(Number),
            creativity: expect.any(Number),
            threat: expect.any(Number),
            ictIndex: expect.any(Number),
          });
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should handle non-existent player stat id',
      async () => {
        const nonExistentId = 'non-existent-id' as PlayerStatId;
        const result = await pipe(
          playerStatService.getPlayerStat(nonExistentId),
          TE.map((stat: PlayerStat | null): O.Option<PlayerStat> => O.fromNullable(stat)),
          TE.fold<ServiceError, O.Option<PlayerStat>, O.Option<PlayerStat>>(
            () => T.of(O.none),
            (statOption) => T.of(statOption),
          ),
        )();

        expect(O.isNone(result)).toBe(true);
      },
      TEST_TIMEOUT,
    );
  });

  describe('Player Stat Creation', () => {
    it(
      'should save player stats',
      async () => {
        // First get all player stats
        const existingStats = await pipe(
          playerStatService.getPlayerStats(),
          TE.fold<ServiceError, readonly PlayerStat[], readonly PlayerStat[]>(
            () => T.of([]),
            (stats) => T.of(stats),
          ),
        )();

        expect(existingStats.length).toBeGreaterThan(0);

        // Create new player stats with different IDs
        const newStats = existingStats.slice(0, 2).map((stat) => ({
          ...stat,
          id: `${stat.id}-new` as PlayerStatId,
        }));

        const result = await pipe(
          playerStatService.savePlayerStats(newStats),
          TE.fold<ServiceError, readonly PlayerStat[], readonly PlayerStat[]>(
            () => T.of([]),
            (stats) => T.of(stats),
          ),
        )();

        expect(result.length).toBe(newStats.length);
        expect(result[0]).toMatchObject({
          id: newStats[0].id,
          eventId: expect.any(Number),
          elementId: expect.any(Number),
          teamId: expect.any(Number),
          form: expect.any(Number),
          influence: expect.any(Number),
          creativity: expect.any(Number),
          threat: expect.any(Number),
          ictIndex: expect.any(Number),
        });
      },
      TEST_TIMEOUT,
    );
  });
});
