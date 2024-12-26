import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createRedisClient } from '../../../../src/infrastructure/cache/client/redis.client';
import { RedisClient, RedisConfig } from '../../../../src/infrastructure/cache/types';
import { createPhaseService } from '../../../../src/services/phases';
import { phaseWorkflows } from '../../../../src/services/phases/workflow';
import type { Phase } from '../../../../src/types/phases.type';
import { PhaseId } from '../../../../src/types/phases.type';

const testPhases: Phase[] = [
  {
    id: 1 as PhaseId,
    name: 'Phase 1',
    startEvent: 1,
    stopEvent: 10,
    highestScore: null,
  },
  {
    id: 2 as PhaseId,
    name: 'Phase 2',
    startEvent: 11,
    stopEvent: 20,
    highestScore: null,
  },
];

describe('Phase Service Integration', () => {
  let redisClient: RedisClient;
  let phaseService: ReturnType<typeof createPhaseService>;

  const redisConfig: RedisConfig = {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    enableOfflineQueue: true,
    commandTimeout: 2000,
    reconnectStrategy: {
      maxAttempts: 5,
      delay: 1000,
    },
  };

  beforeAll(async () => {
    const clientOrError = await createRedisClient(redisConfig)();
    if ('left' in clientOrError) {
      throw new Error('Failed to create Redis client: ' + clientOrError.left.message);
    }
    redisClient = clientOrError.right;

    // Connect to Redis
    await pipe(
      redisClient.connect(),
      TE.fold(
        (error) => {
          console.error('Failed to connect to Redis:', error);
          throw error;
        },
        () => TE.right(undefined),
      ),
    )();

    const bootstrapApi = {
      getBootstrapData: async () => ({
        teams: [],
        phases: testPhases.map((p) => ({
          id: p.id,
          name: p.name,
          start_event: p.startEvent,
          stop_event: p.stopEvent,
        })),
        events: [],
      }),
    };

    phaseService = createPhaseService(bootstrapApi);
  });

  beforeEach(async () => {
    // Clear all test keys
    await pipe(
      redisClient.keys('phase:*'),
      TE.chain((keys) => (keys.length > 0 ? redisClient.del(...keys) : TE.right(0))),
      TE.fold(
        (error) => {
          console.error('Failed to clear test keys:', error);
          return TE.right(undefined);
        },
        () => TE.right(undefined),
      ),
    )();
  });

  afterAll(async () => {
    await pipe(
      redisClient.disconnect(),
      TE.fold(
        (error) => {
          console.error('Failed to disconnect from Redis:', error);
          return TE.right(undefined);
        },
        () => TE.right(undefined),
      ),
    )();
  });

  describe('Phase Service with Redis', () => {
    it('should sync phases to Redis and retrieve them', async () => {
      // First sync phases
      const syncResult = await phaseService.syncPhases()();
      expect(E.isRight(syncResult)).toBe(true);

      // Then get all phases
      const getResult = await phaseService.getPhases()();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult)) {
        expect(getResult.right).toHaveLength(testPhases.length);
        expect(getResult.right[0]).toEqual(testPhases[0]);
      }
    });

    it('should get single phase from Redis', async () => {
      // First sync phases
      await phaseService.syncPhases()();

      // Then get a specific phase
      const getResult = await phaseService.getPhase(1 as PhaseId)();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult)) {
        expect(getResult.right).toEqual(testPhases[0]);
      }
    });

    it('should get current active phase based on event', async () => {
      // First sync phases
      await phaseService.syncPhases()();

      // Then get active phase for event in Phase 1
      const getResult = await phaseService.getCurrentActivePhase(5)();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult)) {
        expect(getResult.right).toEqual(testPhases[0]);
      }
    });
  });

  describe('Phase Workflows with Redis', () => {
    let workflows: ReturnType<typeof phaseWorkflows>;

    beforeEach(() => {
      workflows = phaseWorkflows(phaseService);
    });

    it('should sync and verify phases in Redis', async () => {
      const result = await workflows.syncAndVerifyPhases()();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toHaveLength(testPhases.length);
      }
    });

    it('should get phase details with correct active status', async () => {
      // First sync phases
      await workflows.syncAndVerifyPhases()();

      // Get details for Phase 1 with current event in Phase 1
      const result = await workflows.getPhaseDetails(1 as PhaseId, 5)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right.phase).toEqual(testPhases[0]);
        expect(result.right.isActive).toBe(true);
      }
    });
  });
});
