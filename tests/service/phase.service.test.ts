import { createPhaseCache } from 'domain/phase/cache';
import { type PhaseCache } from 'domain/phase/types';

import { beforeAll, describe, expect, it } from 'bun:test';
import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import { createFplBootstrapDataService } from 'data/fpl/bootstrap.data';
import { type FplBootstrapDataService } from 'data/types';
import * as E from 'fp-ts/Either';
import { redisClient } from 'infrastructure/cache/client';
import { type Logger } from 'pino';
import { createPhaseRepository } from 'repository/phase/repository';
import { type PhaseRepository } from 'repository/phase/types';
import { createPhaseService } from 'service/phase/service';
import { type PhaseService } from 'service/phase/types';
import { phaseWorkflows } from 'service/phase/workflow';

// Test Setup
import {
  type IntegrationTestSetupResult,
  setupIntegrationTest,
} from '../setup/integrationTestSetup';

describe('Phase Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let db: IntegrationTestSetupResult['db'];
  let logger: Logger;
  let phaseRepository: PhaseRepository;
  let phaseCache: PhaseCache;
  let fplDataService: FplBootstrapDataService;
  let phaseService: PhaseService;

  const cachePrefix = CachePrefix.PHASE;
  const season = '2425';

  beforeAll(async () => {
    setup = await setupIntegrationTest();
    db = setup.db;
    logger = setup.logger;

    try {
      await redisClient.ping();
    } catch (error) {
      logger.error({ err: error }, 'Shared redisClient ping failed in beforeAll.');
    }

    phaseRepository = createPhaseRepository();
    phaseCache = createPhaseCache({
      keyPrefix: cachePrefix,
      season: season,
      ttlSeconds: DefaultTTL.PHASE,
    });
    fplDataService = createFplBootstrapDataService();
    phaseService = createPhaseService(fplDataService, phaseRepository, phaseCache);
  });

  describe('Phase Service Integration', () => {
    it('should fetch phases from API, store in database, and cache them', async () => {
      const syncResult = await phaseService.syncPhasesFromApi()();

      expect(E.isRight(syncResult)).toBe(true);

      const getPhasesResult = await phaseService.getPhases()();
      expect(E.isRight(getPhasesResult)).toBe(true);
      if (E.isRight(getPhasesResult) && getPhasesResult.right) {
        const phases = getPhasesResult.right;
        expect(phases).toBeDefined();
        expect(Array.isArray(phases)).toBe(true);
        expect(phases.length).toBeGreaterThan(0);
        const firstPhase = phases[0];
        expect(firstPhase).toHaveProperty('id');
        expect(firstPhase).toHaveProperty('name');
        expect(firstPhase).toHaveProperty('startEvent');
        expect(firstPhase).toHaveProperty('stopEvent');
      }

      // Check DB directly using Drizzle query API
      const dbPhases = await db.query.phases.findMany();
      expect(dbPhases.length).toBeGreaterThan(0);

      // Check cache directly
      const cacheKey = `${cachePrefix}::${season}`;
      const keyExists = await redisClient.exists(cacheKey);
      expect(keyExists).toBe(1);
    });

    it('should get phase by ID after syncing', async () => {
      const syncResult = await phaseService.syncPhasesFromApi()();
      expect(E.isRight(syncResult)).toBe(true);

      const getPhasesResult = await phaseService.getPhases()();
      expect(E.isRight(getPhasesResult)).toBe(true);

      if (E.isRight(getPhasesResult) && getPhasesResult.right) {
        const phases = getPhasesResult.right;
        expect(phases).toBeDefined();
        expect(Array.isArray(phases)).toBe(true);
        expect(phases.length).toBeGreaterThan(0);

        const firstPhaseId = phases[0].id;
        const phaseResult = await phaseService.getPhase(firstPhaseId)();

        expect(E.isRight(phaseResult)).toBe(true);
        if (E.isRight(phaseResult) && phaseResult.right) {
          expect(phaseResult.right).toBeDefined();
          expect(phaseResult.right).toHaveProperty('id', firstPhaseId);
        } else if (E.isLeft(phaseResult)) {
          throw new Error(`Expected Right but got Left: ${JSON.stringify(phaseResult.left)}`);
        }
      } else if (E.isLeft(getPhasesResult)) {
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

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result) && result.right) {
        expect(result.right).toBeDefined();
        expect(result.right).toHaveProperty('context');
        expect(result.right).toHaveProperty('duration');
        expect(result.right.duration).toBeGreaterThan(0);

        // Verify side effect: check database using Drizzle query API
        const dbPhases = await db.query.phases.findMany();
        expect(dbPhases.length).toBeGreaterThan(0);
      } else if (E.isLeft(result)) {
        throw new Error(`Workflow failed: ${JSON.stringify(result.left)}`);
      }
    });
  });
});
