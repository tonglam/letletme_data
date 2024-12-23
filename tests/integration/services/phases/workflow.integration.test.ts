import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import * as E from 'fp-ts/Either';
import { BootstrapApi } from '../../../../src/domains/bootstrap/operations';
import { prisma } from '../../../../src/infrastructure/db/prisma';
import { createPhaseService } from '../../../../src/services/phases';
import { phaseWorkflows } from '../../../../src/services/phases/workflow';
import { PhaseId } from '../../../../src/types/phase.type';

describe('Phase Workflows Integration', () => {
  let phaseService: ReturnType<typeof createPhaseService>;
  let workflows: ReturnType<typeof phaseWorkflows>;
  let firstPhaseId: PhaseId;

  beforeAll(async () => {
    const bootstrapApi: BootstrapApi = {
      getBootstrapData: async () => {
        try {
          const response = await fetch(process.env.BOOTSTRAP_API_URL!);
          if (!response.ok) {
            throw new Error(`API error: ${response.status} - ${await response.text()}`);
          }
          return response.json();
        } catch (error) {
          console.error('Failed to fetch bootstrap data:', error);
          throw error;
        }
      },
    };

    phaseService = createPhaseService(bootstrapApi);
    workflows = phaseWorkflows(phaseService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('syncAndVerifyPhases', () => {
    it('should successfully sync phases from API', async () => {
      const result = await workflows.syncAndVerifyPhases()();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right.length).toBeGreaterThan(0);
        firstPhaseId = result.right[0].id as PhaseId;
      }
    }, 30000); // Increased timeout for API call and database operations
  });

  describe('getPhaseDetails', () => {
    it('should get active phase details', async () => {
      const result = await workflows.getPhaseDetails(firstPhaseId, 1)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right.phase).toBeDefined();
        expect(typeof result.right.isActive).toBe('boolean');
      }
    }, 10000);

    it('should handle non-existent phase', async () => {
      const result = await workflows.getPhaseDetails(999 as PhaseId, 5)();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe('VALIDATION_ERROR');
      }
    });

    it('should handle invalid event ID', async () => {
      const result = await workflows.getPhaseDetails(1 as PhaseId, -1)();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe('VALIDATION_ERROR');
      }
    });
  });
});
