import { PrismaClient } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Use the generic setup

// Import the SHARED redis client used by the application

// Specific imports for this test suite
import { CachePrefix } from '../../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../../src/data/fpl/bootstrap.data';
import { FplBootstrapDataService } from '../../../src/data/types';
import { createPhaseCache } from '../../../src/domains/phase/cache';
import { PhaseCache } from '../../../src/domains/phase/types';
import { redisClient } from '../../../src/infrastructures/cache/client';
import { HTTPClient } from '../../../src/infrastructures/http';
import { createPhaseRepository } from '../../../src/repositories/phase/repository';
import { PhaseRepository } from '../../../src/repositories/phase/type';
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
  const season = '2425';

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
    phaseCache = createPhaseCache({
      keyPrefix: cachePrefix,
      season: season,
    });
    fplDataService = createFplBootstrapDataService(httpClient, logger);
    phaseService = createPhaseService(fplDataService, phaseRepository, phaseCache);
  });

  afterAll(async () => {
    await teardownIntegrationTest(setup);
  });

  describe('Phase Service Integration', () => {
    it('should fetch phases from API, store in database, and cache them', async () => {
      const syncResult = await phaseService.syncPhasesFromApi()();

      // Check sync succeeded (returned Right<void>)
      expect(E.isRight(syncResult)).toBe(true);

      // Now check if phases were actually stored by fetching them
      const getPhasesResult = await phaseService.getPhases()();
      expect(E.isRight(getPhasesResult)).toBe(true);
      if (E.isRight(getPhasesResult)) {
        const phases = getPhasesResult.right;
        expect(phases.length).toBeGreaterThan(0);
        const firstPhase = phases[0];
        expect(firstPhase).toHaveProperty('id');
        expect(firstPhase).toHaveProperty('name');
        expect(firstPhase).toHaveProperty('startEvent');
        expect(firstPhase).toHaveProperty('stopEvent');
      }

      // Check DB directly
      const dbPhases = await prisma.phase.findMany();
      expect(dbPhases.length).toBeGreaterThan(0);

      // Check cache directly
      const cacheKey = `${cachePrefix}::${season}`;
      // Use shared client for check
      const keyExists = await redisClient.exists(cacheKey);
      expect(keyExists).toBe(1);
    });

    it('should get phase by ID after syncing', async () => {
      const syncResult = await phaseService.syncPhasesFromApi()();
      expect(E.isRight(syncResult)).toBe(true); // Ensure sync completed successfully (Right<void>)

      // Fetch all phases to get a valid ID
      const getPhasesResult = await phaseService.getPhases()();
      expect(E.isRight(getPhasesResult)).toBe(true);

      if (E.isRight(getPhasesResult)) {
        const phases = getPhasesResult.right;
        expect(phases.length).toBeGreaterThan(0); // Make sure we have phases to test with

        const firstPhaseId = phases[0].id;
        const phaseResult = await phaseService.getPhase(firstPhaseId)();

        expect(E.isRight(phaseResult)).toBe(true);
        if (E.isRight(phaseResult)) {
          // Check Right<Phase> explicitly
          expect(phaseResult.right).toBeDefined();
          expect(phaseResult.right.id).toEqual(firstPhaseId);
        } else {
          // Fail test if phaseResult is Left
          throw new Error(`Expected Right but got Left: ${JSON.stringify(phaseResult.left)}`);
        }
      } else {
        // Fail test if getPhasesResult is Left
        throw new Error(
          `Expected Right but got Left when getting phases: ${JSON.stringify(getPhasesResult.left)}`,
        );
      }
    });
  });

  describe('Phase Workflow Integration', () => {
    it('should execute the sync phases workflow end-to-end', async () => {
      const workflows = phaseWorkflows(phaseService);
      const result = await workflows.syncPhases()();

      expect(E.isRight(result)).toBe(true); // Check workflow completed successfully
      if (E.isRight(result)) {
        expect(result.right.context).toBeDefined();
        expect(result.right.duration).toBeGreaterThan(0);
        // WorkflowResult doesn't contain the void result, just context/duration

        // Verify side effect: check database
        const dbPhases = await prisma.phase.findMany();
        expect(dbPhases.length).toBeGreaterThan(0); // Check that phases were actually synced
      } else {
        // Fail test if workflow result is Left
        throw new Error(`Workflow failed: ${JSON.stringify(result.left)}`);
      }
    });
  });
});
