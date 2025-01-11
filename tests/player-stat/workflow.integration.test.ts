import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { ExtendedBootstrapApi } from '../../src/domain/bootstrap/types';
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
import type { WorkflowResult } from '../../src/service/player-stat/types';
import { getCurrentSeason } from '../../src/types/base.type';
import {
  APIErrorCode,
  createAPIError,
  ServiceError,
  ServiceErrorCode,
} from '../../src/types/error.type';
import type { Event } from '../../src/types/event.type';
import { toDomainEvent, validateEventId } from '../../src/types/event.type';
import type { PlayerStat, PlayerStatId } from '../../src/types/player-stat.type';
import { toDomainPlayerStat } from '../../src/types/player-stat.type';

describe('Player Stat Workflow Integration Tests', () => {
  // Service and workflow instances
  const fplClient = createFPLClient({
    retryConfig: {
      ...DEFAULT_RETRY_CONFIG,
      attempts: 2,
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
  const workflows = playerStatService.workflows;

  beforeAll(async () => {
    try {
      // Wait for Redis connection
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Clear test data
      await prisma.playerStat.deleteMany();

      // Clear test-specific cache keys
      const season = getCurrentSeason();
      const baseKey = `player-stat::${season}`;

      const multi = playerStatRedisCache.client.multi();
      multi.del(baseKey);
      await multi.exec();
    } catch (error) {
      console.error('Error in beforeAll:', error);
      throw error;
    }
  });

  afterAll(async () => {
    try {
      // Clean up test data
      await prisma.playerStat.deleteMany();

      // Verify cleanup
      await playerStatRedisCache.client.keys('*player-stat*');

      // Close connections
      await playerStatRedisCache.client.quit();
      await eventRedisCache.client.quit();
      await prisma.$disconnect();
    } catch (error) {
      console.error('Error in afterAll:', error);
      throw error;
    }
  });

  describe('Workflow Setup', () => {
    it('should create workflows with proper interface', () => {
      expect(workflows).toBeDefined();
      expect(workflows.syncPlayerStats).toBeDefined();
      expect(typeof workflows.syncPlayerStats).toBe('function');
    });
  });

  describe('Player Stat Sync Workflow', () => {
    it('should execute sync workflow successfully', async () => {
      const result = await pipe(
        workflows.syncPlayerStats(),
        TE.fold<
          ServiceError,
          WorkflowResult<readonly PlayerStat[]>,
          WorkflowResult<readonly PlayerStat[]> | null
        >(
          () => T.of(null),
          (result) => T.of(result),
        ),
      )();

      expect(result).not.toBeNull();
      if (result) {
        // Verify workflow context
        expect(result.context).toBeDefined();
        expect(result.context.workflowId).toBe('player-stat-sync');
        expect(result.context.startTime).toBeInstanceOf(Date);

        // Verify workflow metrics
        expect(result.duration).toBeGreaterThan(0);

        // Verify workflow result
        expect(Array.isArray(result.result)).toBe(true);
        expect(result.result.length).toBeGreaterThan(0);
        expect(result.result[0]).toMatchObject({
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
      }
    }, 30000);

    it('should handle workflow errors properly', async () => {
      // Create mock API that always fails
      const mockError = createAPIError({
        code: APIErrorCode.SERVICE_ERROR,
        message: 'Failed to fetch player stats from API',
        cause: new Error('Network error'),
        details: { endpoint: '/bootstrap/elements' },
      });

      const failingApi: ExtendedBootstrapApi = {
        getBootstrapEvents: () => TE.left(mockError),
        getBootstrapPhases: () => TE.left(mockError),
        getBootstrapTeams: () => TE.left(mockError),
        getBootstrapElements: () => TE.left(mockError),
        getBootstrapData: async () => {
          throw new Error('Network error');
        },
      };

      const failingService = createPlayerStatService(
        failingApi,
        playerStatRepository,
        eventOperations,
      );
      const failingWorkflows = failingService.workflows;

      const result = await pipe(
        failingWorkflows.syncPlayerStats(),
        TE.fold<ServiceError, WorkflowResult<readonly PlayerStat[]>, ServiceError>(
          (error) => T.of(error),
          () => {
            throw new Error('Expected workflow to fail but it succeeded');
          },
        ),
      )();

      // Verify only top-level workflow error
      expect(result).toBeDefined();
      expect(result.name).toBe('ServiceError');
      expect(result.code).toBe(ServiceErrorCode.INTEGRATION_ERROR);
      expect(result.message).toBe(
        'Player stat sync workflow failed: Failed to fetch player stats from API',
      );
      expect(result.timestamp).toBeInstanceOf(Date);
    }, 10000);
  });

  describe('Workflow Metrics', () => {
    beforeEach(async () => {
      // Clear only player-stat-related cache keys
      const season = getCurrentSeason();
      const baseKey = `player-stat::${season}`;

      const multi = playerStatRedisCache.client.multi();
      multi.del(baseKey);
      await multi.exec();
    });

    it('should track workflow execution time', async () => {
      const result = await pipe(
        workflows.syncPlayerStats(),
        TE.fold<
          ServiceError,
          WorkflowResult<readonly PlayerStat[]>,
          WorkflowResult<readonly PlayerStat[]>
        >(
          (error) =>
            T.of({
              duration: 0,
              context: { workflowId: '', startTime: new Date() },
              result: [],
              error,
            }),
          (result) => T.of(result),
        ),
      )();

      expect(result.duration).toBeGreaterThan(0);
      expect(result.duration).toBeLessThan(30000); // Reasonable timeout
    }, 30000);

    it('should include workflow context in results', async () => {
      const result = await pipe(
        workflows.syncPlayerStats(),
        TE.fold<
          ServiceError,
          WorkflowResult<readonly PlayerStat[]>,
          WorkflowResult<readonly PlayerStat[]>
        >(
          (error) =>
            T.of({
              duration: 0,
              context: { workflowId: 'player-stat-sync', startTime: new Date() },
              result: [],
              error,
            }),
          (result) => T.of(result),
        ),
      )();

      expect(result.context).toMatchObject({
        workflowId: 'player-stat-sync',
        startTime: expect.any(Date),
      });
    }, 30000);
  });
});
