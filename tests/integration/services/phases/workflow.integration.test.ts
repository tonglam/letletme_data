import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import * as E from 'fp-ts/Either';
import { BootstrapApi } from '../../../../src/domains/bootstrap/operations';
import { FPL_API_CONFIG } from '../../../../src/infrastructure/api/fpl/config';
import { prisma } from '../../../../src/infrastructure/db/prisma';
import { createPhaseService } from '../../../../src/services/phases';
import { phaseWorkflows } from '../../../../src/services/phases/workflow';
import { Phase, PhaseId, PhaseResponse, validatePhaseId } from '../../../../src/types/phase.type';

interface FPLBootstrapResponse {
  phases: PhaseResponse[];
  [key: string]: unknown;
}

describe('Phase Workflows Integration', () => {
  let phaseService: ReturnType<typeof createPhaseService>;
  let workflows: ReturnType<typeof phaseWorkflows>;
  let firstPhaseId: PhaseId;

  beforeAll(async () => {
    const bootstrapApi: BootstrapApi = {
      getBootstrapData: async () => {
        try {
          console.log('Fetching data from FPL API...');
          const response = await fetch(FPL_API_CONFIG.bootstrap.static);

          if (!response.ok) {
            const errorText = await response.text();
            console.error('API response not OK:', {
              status: response.status,
              statusText: response.statusText,
              body: errorText,
            });
            throw new Error(`API error: ${response.status} - ${errorText}`);
          }

          console.log('Parsing API response...');
          const data = (await response.json()) as FPLBootstrapResponse;
          console.log('API response data:', data);

          if (!data.phases || !Array.isArray(data.phases)) {
            console.error('Invalid API response format:', data);
            throw new Error('Invalid API response format');
          }

          console.log('Processing phases data...');
          const processedPhases = data.phases
            .filter((phase) => phase.start_event && phase.stop_event)
            .sort((a, b) => a.start_event - b.start_event)
            .map((phase) => {
              const phaseIdResult = validatePhaseId(phase.id);
              if (E.isLeft(phaseIdResult)) {
                throw new Error(`Invalid phase ID: ${phase.id}`);
              }

              return {
                id: phaseIdResult.right,
                name: phase.name,
                startEvent: phase.start_event,
                stopEvent: phase.stop_event,
                highestScore: null,
              } satisfies Phase;
            });

          console.log('Processed phases:', processedPhases);
          return processedPhases;
        } catch (error) {
          console.error('Failed to fetch bootstrap data:', error);
          throw error;
        }
      },
    };

    phaseService = createPhaseService(bootstrapApi);
    workflows = phaseWorkflows(phaseService);
  });

  beforeEach(async () => {
    // Clean database before each test
    await prisma.phase.deleteMany();
  });

  afterAll(async () => {
    // Clean up database after tests
    await prisma.phase.deleteMany();
    await prisma.$disconnect();
  });

  describe('syncAndVerifyPhases', () => {
    it('should successfully sync phases from API', async () => {
      // First, ensure database is empty
      const initialPhases = await prisma.phase.findMany();
      expect(initialPhases.length).toBe(0);

      // Sync phases
      const result = await workflows.syncAndVerifyPhases()();
      console.log('Sync result:', result);
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right.length).toBeGreaterThan(0);
        console.log('Synced phases:', result.right);

        // Store first phase for later tests
        const firstPhase = result.right[0];
        const phaseId = Number(firstPhase.id);
        const phaseIdResult = validatePhaseId(phaseId);
        if (E.isLeft(phaseIdResult)) {
          throw new Error(`Invalid phase ID: ${phaseId}`);
        }
        firstPhaseId = phaseIdResult.right;

        // Verify phases are actually persisted in database
        const dbPhases = await prisma.phase.findMany();
        expect(dbPhases.length).toBe(result.right.length);

        // Verify first phase matches
        const dbFirstPhase = await prisma.phase.findUnique({
          where: { id: phaseId },
        });
        expect(dbFirstPhase).toBeDefined();
        expect(dbFirstPhase?.name).toBe(firstPhase.name);
        expect(dbFirstPhase?.startEvent).toBe(firstPhase.startEvent);
        expect(dbFirstPhase?.stopEvent).toBe(firstPhase.stopEvent);
      }
    }, 30000); // Increased timeout for API call
  });

  describe('getPhaseDetails', () => {
    it('should get active phase details', async () => {
      // First sync phases to get data
      const syncResult = await workflows.syncAndVerifyPhases()();
      console.log('Sync result for phase details:', syncResult);
      expect(E.isRight(syncResult)).toBe(true);
      if (E.isRight(syncResult)) {
        const firstPhase = syncResult.right[0];
        const phaseId = Number(firstPhase.id);
        const phaseIdResult = validatePhaseId(phaseId);
        if (E.isLeft(phaseIdResult)) {
          throw new Error(`Invalid phase ID: ${phaseId}`);
        }
        firstPhaseId = phaseIdResult.right;
      }

      // Get phase details using the phase's start event (should be active)
      const result = await workflows.getPhaseDetails(firstPhaseId, 1)();
      console.log('Phase details result:', result);
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right.phase).toBeDefined();
        expect(typeof result.right.isActive).toBe('boolean');
        expect(result.right.phase.id).toBe(firstPhaseId);
        expect(result.right.isActive).toBe(true);
      }
    }, 30000); // Increased timeout for API call

    it('should handle non-existent phase', async () => {
      const invalidIdResult = validatePhaseId(999);
      if (E.isLeft(invalidIdResult)) {
        throw new Error('Failed to create invalid phase ID for test');
      }
      const invalidId = invalidIdResult.right;

      // Try to get phase details
      const result = await workflows.getPhaseDetails(invalidId, 5)();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe('VALIDATION_ERROR');
        expect(result.left.message).toBe(`Phase ${invalidId} not found`);
      }
    });

    it('should handle invalid event ID', async () => {
      const validIdResult = validatePhaseId(1);
      if (E.isLeft(validIdResult)) {
        throw new Error('Failed to create valid phase ID for test');
      }
      const validId = validIdResult.right;

      const result = await workflows.getPhaseDetails(validId, -1)();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe('VALIDATION_ERROR');
        expect(result.left.message).toBe('Invalid event ID provided');
      }
    });
  });
});
