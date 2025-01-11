import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { ExtendedBootstrapApi } from '../../src/domain/bootstrap/types';
import { createPlayerCache } from '../../src/domain/player/cache';
import { createPlayerRepository } from '../../src/domain/player/repository';
import { createTeamRepository } from '../../src/domain/team/repository';
import { createRedisCache } from '../../src/infrastructure/cache/redis-cache';
import { prisma } from '../../src/infrastructure/db/prisma';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructure/http/client/utils';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import { createPlayerService } from '../../src/service/player';
import { createTeamService } from '../../src/service/team';
import { getCurrentSeason } from '../../src/types/base.type';
import {
  APIErrorCode,
  createAPIError,
  ServiceError,
  ServiceErrorCode,
} from '../../src/types/error.type';
import type { Player, PlayerId } from '../../src/types/player.type';
import { toDomainPlayer } from '../../src/types/player.type';
import { TeamId } from '../../src/types/team.type';

// Define workflow result type
interface PlayerWorkflowResult {
  readonly duration: number;
  readonly result: readonly Player[];
}

describe('Player Workflow Integration Tests', () => {
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

  // Create team service for player enhancement
  const teamRepository = createTeamRepository(prisma);
  const teamService = createTeamService(bootstrapApi, teamRepository);

  const playerService = createPlayerService(
    bootstrapApi,
    playerRepository,
    {
      bootstrapApi,
      teamService: {
        getTeam: (id: number) => teamService.getTeam(id as TeamId),
      },
    },
    playerCache,
  );
  const workflows = playerService.workflows;

  beforeAll(async () => {
    try {
      // Wait for Redis connection
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Clear test data
      await prisma.player.deleteMany();

      // Clear test-specific cache keys
      const season = getCurrentSeason();
      const baseKey = `player::${season}`;

      const multi = redisCache.client.multi();
      multi.del(baseKey);
      await multi.exec();
    } catch (error) {
      console.error('Error in beforeAll:', error);
      throw error;
    }
  });

  afterAll(async () => {
    try {
      // // Clean up test data
      // await prisma.player.deleteMany();

      // // Verify cleanup
      // await redisCache.client.keys('*player*');

      // Close connections
      await redisCache.client.quit();
      await prisma.$disconnect();
    } catch (error) {
      console.error('Error in afterAll:', error);
      throw error;
    }
  });

  describe('Workflow Setup', () => {
    it('should create workflows with proper interface', () => {
      expect(workflows).toBeDefined();
      expect(workflows.syncPlayers).toBeDefined();
      expect(typeof workflows.syncPlayers).toBe('function');
    });
  });

  describe('Player Sync Workflow', () => {
    it('should execute sync workflow successfully', async () => {
      const result = await pipe(
        workflows.syncPlayers(),
        TE.fold<ServiceError, PlayerWorkflowResult, PlayerWorkflowResult | null>(
          () => T.of(null),
          (result) => T.of(result),
        ),
      )();

      expect(result).not.toBeNull();
      if (result) {
        // Verify workflow metrics
        expect(result.duration).toBeGreaterThan(0);

        // Verify workflow result
        expect(Array.isArray(result.result)).toBe(true);
        expect(result.result.length).toBeGreaterThan(0);
        expect(result.result[0]).toMatchObject({
          id: expect.any(Number),
          elementCode: expect.any(Number),
          price: expect.any(Number),
          startPrice: expect.any(Number),
          elementType: expect.any(Number),
          webName: expect.any(String),
          teamId: expect.any(Number),
        });
      }
    }, 30000);

    it('should handle workflow errors properly', async () => {
      // Create mock API that always fails
      const mockError = createAPIError({
        code: APIErrorCode.SERVICE_ERROR,
        message: 'Failed to fetch players from API',
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

      const failingService = createPlayerService(failingApi, playerRepository, {
        bootstrapApi: failingApi,
        teamService: {
          getTeam: (id: number) => teamService.getTeam(id as TeamId),
        },
      });
      const failingWorkflows = failingService.workflows;

      const result = await pipe(
        failingWorkflows.syncPlayers(),
        TE.fold<ServiceError, PlayerWorkflowResult, ServiceError>(
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
      expect(result.message).toBe('Player sync workflow failed: Service integration failed');
      expect(result.timestamp).toBeInstanceOf(Date);
    }, 10000);
  });

  describe('Workflow Metrics', () => {
    beforeEach(async () => {
      // Clear only player-related cache keys
      const season = getCurrentSeason();
      const baseKey = `player::${season}`;

      const multi = redisCache.client.multi();
      multi.del(baseKey);
      await multi.exec();
    });

    it('should track workflow execution time', async () => {
      const result = await pipe(
        workflows.syncPlayers(),
        TE.fold<ServiceError, PlayerWorkflowResult, PlayerWorkflowResult>(
          () =>
            T.of({
              duration: 0,
              result: [],
            }),
          (result) => T.of(result),
        ),
      )();

      expect(result.duration).toBeGreaterThan(0);
      expect(result.duration).toBeLessThan(30000); // Reasonable timeout
    }, 30000);

    it('should include workflow result', async () => {
      const result = await pipe(
        workflows.syncPlayers(),
        TE.fold<ServiceError, PlayerWorkflowResult, PlayerWorkflowResult>(
          () =>
            T.of({
              duration: 0,
              result: [],
            }),
          (result) => T.of(result),
        ),
      )();

      expect(result.result).toBeDefined();
      expect(Array.isArray(result.result)).toBe(true);
    }, 30000);
  });
});
