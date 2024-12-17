import { beforeAll, describe, expect, test } from '@jest/globals';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';

import { phaseRepository } from '../../src/domains/phases/repository';
import { APIError } from '../../src/infrastructure/api/common/errors';
import { createFPLClient } from '../../src/infrastructure/api/fpl';
import { createPhaseService } from '../../src/services/phases';
import { Phase, PhaseId, toDomainPhase, validatePhaseId } from '../../src/types/phase.type';

describe('Phase Service Integration', () => {
  const TEST_EVENT_ID = 15; // Mid-season event for reliable phase testing
  let phaseService: ReturnType<typeof createPhaseService>;
  let firstPhaseId: PhaseId;

  const handleError = (error: APIError): never => {
    throw new Error(`Operation failed: ${error.message}`);
  };

  beforeAll(async () => {
    // Clean existing data
    await pipe(phaseRepository.deleteAll(), TE.getOrElse(handleError))();

    // Initialize FPL client
    const fplClient = await pipe(
      createFPLClient()(),
      E.getOrElseW((error) => {
        throw new Error(`FPL client initialization failed: ${error.message}`);
      }),
    );

    // Create phase service with bootstrap data
    phaseService = createPhaseService({
      getBootstrapData: async () => {
        const bootstrapResult = await fplClient.getBootstrapStatic();
        if (E.isLeft(bootstrapResult)) {
          console.error('Failed to get bootstrap data:', bootstrapResult.left);
          return null;
        }
        const { phases } = bootstrapResult.right;
        const domainPhases = phases
          .map((p) => toDomainPhase(p))
          .filter(E.isRight)
          .map((p) => p.right);
        if (domainPhases.length === 0) {
          console.error('No valid phases found in bootstrap data');
          return null;
        }
        return domainPhases;
      },
    });
  });

  // afterAll(async () => {
  //   await pipe(phaseRepository.deleteAll(), TE.getOrElse(handleError))();
  // });

  describe('Phase Service Workflow', () => {
    test('1. should sync phases from FPL API to database', async () => {
      // Clean existing data before sync
      await pipe(phaseRepository.deleteAll(), TE.getOrElse(handleError))();

      // When: syncing phases from API to database
      const syncResult = await phaseService.syncPhases()();
      if (E.isLeft(syncResult)) {
        console.error('Sync failed:', syncResult.left);
      }
      expect(E.isRight(syncResult)).toBe(true);

      const phasesFromAPI = pipe(
        syncResult,
        E.fold(handleError, (phases) => phases),
      );
      expect(phasesFromAPI.length).toBeGreaterThan(0);

      // Then: verify phases are saved in database
      const dbPhasesResult = await phaseService.getPhases()();
      const phasesInDB = pipe(
        dbPhasesResult,
        E.fold(handleError, (phases) => phases),
      );

      // Verify data integrity
      expect(phasesInDB.length).toBe(phasesFromAPI.length);
      expect([...phasesInDB]).toEqual(expect.arrayContaining([...phasesFromAPI]));

      // Store first phase ID for subsequent tests
      const phaseIdResult = validatePhaseId(phasesFromAPI[0].id);
      expect(E.isRight(phaseIdResult)).toBe(true);
      if (E.isLeft(phaseIdResult)) throw new Error(`Invalid phase ID: ${phaseIdResult.left}`);
      firstPhaseId = phaseIdResult.right;

      // Verify phase structure
      const firstPhase = phasesFromAPI[0];
      const expectedPhaseKeys: Array<keyof Phase> = ['id', 'name', 'startEvent', 'stopEvent'];
      expectedPhaseKeys.forEach((key) => {
        expect(firstPhase).toHaveProperty(key as string);
      });
    }, 30000);

    test('2. should retrieve all phases', async () => {
      const phasesResult = await phaseService.getPhases()();
      expect(E.isRight(phasesResult)).toBe(true);

      const phases = pipe(
        phasesResult,
        E.fold(handleError, (phases) => phases),
      );
      expect(phases.length).toBeGreaterThan(0);
    });

    test('3. should retrieve specific phase by ID', async () => {
      const phaseResult = await phaseService.getPhase(firstPhaseId)();
      expect(E.isRight(phaseResult)).toBe(true);

      const phase = pipe(
        phaseResult,
        E.fold(handleError, (phase) => phase),
      );
      expect(phase).not.toBeNull();
      expect(phase?.id).toBe(firstPhaseId);
    });

    test('4. should retrieve active phase for current event', async () => {
      const activePhaseResult = await phaseService.getCurrentActivePhase(TEST_EVENT_ID)();
      expect(E.isRight(activePhaseResult)).toBe(true);

      const activePhase = pipe(
        activePhaseResult,
        E.fold(handleError, (phase) => phase),
      );
      expect(activePhase).not.toBeNull();
      expect(activePhase?.startEvent).toBeLessThanOrEqual(TEST_EVENT_ID);
      expect(activePhase?.stopEvent).toBeGreaterThanOrEqual(TEST_EVENT_ID);
    }, 10000);
  });
});
