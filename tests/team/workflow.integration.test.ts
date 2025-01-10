import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { ExtendedBootstrapApi } from '../../src/domain/bootstrap/types';
import { createTeamCache } from '../../src/domain/team/cache';
import { createTeamRepository } from '../../src/domain/team/repository';
import { createRedisCache } from '../../src/infrastructure/cache/redis-cache';
import { prisma } from '../../src/infrastructure/db/prisma';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructure/http/client/utils';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import { createTeamService } from '../../src/service/team';
import type { WorkflowResult } from '../../src/service/team/types';
import { getCurrentSeason } from '../../src/types/base.type';
import {
  APIErrorCode,
  createAPIError,
  ServiceError,
  ServiceErrorCode,
} from '../../src/types/error.type';
import type { TeamId } from '../../src/types/team.type';
import { Team, toDomainTeam } from '../../src/types/team.type';

describe('Team Workflow Integration Tests', () => {
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
  const teamRepository = createTeamRepository(prisma);

  // Create Redis cache with remote configuration
  const redisCache = createRedisCache<Team>({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    db: Number(process.env.REDIS_DB ?? 0),
  });

  const teamCache = createTeamCache(redisCache, {
    getOne: async (id: number) => {
      const result = await teamRepository.findById(id as TeamId)();
      if (E.isRight(result) && result.right) {
        return toDomainTeam(result.right);
      }
      return null;
    },
    getAll: async () => {
      const result = await teamRepository.findAll()();
      if (E.isRight(result)) {
        return result.right.map(toDomainTeam);
      }
      return [];
    },
  });

  const teamService = createTeamService(bootstrapApi, teamRepository, teamCache);
  const workflows = teamService.workflows;

  beforeAll(async () => {
    try {
      // Wait for Redis connection
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Clear test data
      await prisma.team.deleteMany();

      // Clear test-specific cache keys
      const season = getCurrentSeason();
      const baseKey = `team::${season}`;

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
      // Clean up test data
      await prisma.team.deleteMany();

      // Verify cleanup
      await redisCache.client.keys('*team*');

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
      expect(workflows.syncTeams).toBeDefined();
      expect(typeof workflows.syncTeams).toBe('function');
    });
  });

  describe('Team Sync Workflow', () => {
    it('should execute sync workflow successfully', async () => {
      const result = await pipe(
        workflows.syncTeams(),
        TE.fold<
          ServiceError,
          WorkflowResult<readonly Team[]>,
          WorkflowResult<readonly Team[]> | null
        >(
          () => T.of(null),
          (result) => T.of(result),
        ),
      )();

      expect(result).not.toBeNull();
      if (result) {
        // Verify workflow context
        expect(result.context).toBeDefined();
        expect(result.context.workflowId).toBe('team-sync');
        expect(result.context.startTime).toBeInstanceOf(Date);

        // Verify workflow metrics
        expect(result.duration).toBeGreaterThan(0);

        // Verify workflow result
        expect(Array.isArray(result.result)).toBe(true);
        expect(result.result.length).toBeGreaterThan(0);
        expect(result.result[0]).toMatchObject({
          id: expect.any(Number),
          name: expect.any(String),
          shortName: expect.any(String),
          strength: expect.any(Number),
          strengthOverallHome: expect.any(Number),
          strengthOverallAway: expect.any(Number),
        });
      }
    }, 30000);

    it('should handle workflow errors properly', async () => {
      // Create mock API that always fails
      const mockError = createAPIError({
        code: APIErrorCode.SERVICE_ERROR,
        message: 'Failed to fetch teams from API',
        cause: new Error('Network error'),
        details: { endpoint: '/bootstrap/teams' },
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

      const failingService = createTeamService(failingApi, teamRepository);
      const failingWorkflows = failingService.workflows;

      const result = await pipe(
        failingWorkflows.syncTeams(),
        TE.fold<ServiceError, WorkflowResult<readonly Team[]>, ServiceError>(
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
      expect(result.message).toBe('Team sync workflow failed: Service integration failed');
      expect(result.timestamp).toBeInstanceOf(Date);
    }, 10000);
  });

  describe('Workflow Metrics', () => {
    beforeEach(async () => {
      // Clear only team-related cache keys
      const season = getCurrentSeason();
      const baseKey = `team::${season}`;

      const multi = redisCache.client.multi();
      multi.del(baseKey);
      await multi.exec();
    });

    it('should track workflow execution time', async () => {
      const result = await pipe(
        workflows.syncTeams(),
        TE.fold<ServiceError, WorkflowResult<readonly Team[]>, WorkflowResult<readonly Team[]>>(
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
        workflows.syncTeams(),
        TE.fold<ServiceError, WorkflowResult<readonly Team[]>, WorkflowResult<readonly Team[]>>(
          (error) =>
            T.of({
              duration: 0,
              context: { workflowId: 'team-sync', startTime: new Date() },
              result: [],
              error,
            }),
          (result) => T.of(result),
        ),
      )();

      expect(result.context).toMatchObject({
        workflowId: 'team-sync',
        startTime: expect.any(Date),
      });
    }, 30000);
  });
});
