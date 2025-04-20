import { PrismaClient } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Use the generic setup

// Import the SHARED redis client used by the application

// Specific imports for this test suite
import { CachePrefix } from '../../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../../src/data/fpl/bootstrap.data';
import { FplBootstrapDataService } from '../../../src/data/types';
import { createPhaseCache } from '../../../src/domains/phase/cache';
import { PhaseCache, PhaseRepository } from '../../../src/domains/phase/types';
import { redisClient } from '../../../src/infrastructures/cache/client';
import { HTTPClient } from '../../../src/infrastructures/http';
import { createPhaseRepository } from '../../../src/repositories/phase/repository';
import { createPhaseService } from '../../../src/services/phase/service';
import { PhaseService } from '../../../src/services/phase/types';
import { phaseWorkflows } from '../../../src/services/phase/workflow';
import {
  IntegrationTestSetupResult,
  setupIntegrationTest,
  teardownIntegrationTest,
} from '../../setup/integrationTestSetup';

describe('Phase Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let prisma: PrismaClient;
  let logger: Logger;
  let httpClient: HTTPClient;
  let phaseRepository: PhaseRepository;
  let phaseCache: PhaseCache;
  let fplDataService: FplBootstrapDataService;
  let phaseService: PhaseService;

  // Use standard prefix, rely on separate test DB for isolation
  const cachePrefix = CachePrefix.PHASE;
  const testSeason = '2425';

  beforeAll(async () => {
    setup = await setupIntegrationTest();
    prisma = setup.prisma;
    logger = setup.logger;
    httpClient = setup.httpClient;

    // Ping shared client (optional)
    try {
      await redisClient.ping();
    } catch (error) {
      logger.error({ err: error }, 'Shared redisClient ping failed in beforeAll.');
    }

    phaseRepository = createPhaseRepository(prisma);
    // createPhaseCache uses the imported singleton redisClient internally
    phaseCache = createPhaseCache(phaseRepository, {
      keyPrefix: cachePrefix,
      season: testSeason,
    });
    fplDataService = createFplBootstrapDataService(httpClient, logger);
    phaseService = createPhaseService(fplDataService, phaseRepository, phaseCache);
  });

  beforeEach(async () => {
    await prisma.phase.deleteMany({});
    // Use shared client for cleanup
    const keys = await redisClient.keys(`${cachePrefix}::${testSeason}*`);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  });

  afterAll(async () => {
    await teardownIntegrationTest(setup);
  });

  describe('Phase Service Integration', () => {
    it('should fetch phases from API, store in database, and cache them', async () => {
      const syncResult = await phaseService.syncPhasesFromApi()();

      expect(E.isRight(syncResult)).toBe(true);
      if (E.isRight(syncResult)) {
        const phases = syncResult.right;
        expect(phases.length).toBeGreaterThan(0);
        const firstPhase = phases[0];
        expect(firstPhase).toHaveProperty('id');
        expect(firstPhase).toHaveProperty('name');
        expect(firstPhase).toHaveProperty('startEvent');
        expect(firstPhase).toHaveProperty('stopEvent');
      }

      const dbPhases = await prisma.phase.findMany();
      expect(dbPhases.length).toBeGreaterThan(0);

      const cacheKey = `${cachePrefix}::${testSeason}`;
      // Use shared client for check
      const keyExists = await redisClient.exists(cacheKey);
      expect(keyExists).toBe(1);
    });

    it('should get phase by ID after syncing', async () => {
      const syncResult = await phaseService.syncPhasesFromApi()();

      if (E.isRight(syncResult)) {
        const phases = syncResult.right;
        if (phases.length > 0) {
          const firstPhaseId = phases[0].id;
          const phaseResult = await phaseService.getPhase(firstPhaseId)();

          expect(E.isRight(phaseResult)).toBe(true);
          if (E.isRight(phaseResult) && phaseResult.right) {
            expect(phaseResult.right.id).toEqual(firstPhaseId);
          }
        }
      }
    });
  });

  describe('Phase Workflow Integration', () => {
    it('should execute the sync phases workflow end-to-end', async () => {
      const workflows = phaseWorkflows(phaseService);
      const result = await workflows.syncPhases()();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right.context).toBeDefined();
        expect(result.right.duration).toBeGreaterThan(0);
        expect(result.right.result).toBeDefined();
        expect(result.right.result.length).toBeGreaterThan(0);

        const dbPhases = await prisma.phase.findMany();
        expect(dbPhases.length).toEqual(result.right.result.length);
      }
    });
  });
});
