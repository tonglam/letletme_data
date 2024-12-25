import * as E from 'fp-ts/Either';
import { BootstrapApi } from '../../../../src/domains/bootstrap/operations';
import { prisma } from '../../../../src/infrastructure/db/prisma';
import { createPhaseService } from '../../../../src/services/phases';
import { phaseWorkflows } from '../../../../src/services/phases/workflow';
import type { PhaseId } from '../../../../src/types/phases.type';
import { getBootstrapData } from '../../../../tests/fixtures/bootstrap';

describe('Phase Workflows Integration', () => {
  let phaseService: ReturnType<typeof createPhaseService>;

  beforeAll(async () => {
    const bootstrapApi: BootstrapApi = {
      getBootstrapData,
      getBootstrapEvents: async () => [],
    };

    phaseService = createPhaseService(bootstrapApi);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('getPhaseDetails', () => {
    let workflows: ReturnType<typeof phaseWorkflows>;
    let firstPhaseId: PhaseId;

    beforeAll(async () => {
      workflows = phaseWorkflows(phaseService);
      const phases = await getBootstrapData();
      firstPhaseId = phases?.[0]?.id ?? (1 as PhaseId);
    });

    it('should return phase details for valid phase ID and limit', async () => {
      const result = await workflows.getPhaseDetails(firstPhaseId, 1)();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        const phaseDetails = result.right;
        expect(phaseDetails).toBeDefined();
        expect(phaseDetails.phase).toBeDefined();
        expect(phaseDetails.phase.id).toBe(firstPhaseId);
      }
    });

    it('should handle invalid phase ID', async () => {
      const invalidId = 999 as PhaseId;
      const result = await workflows.getPhaseDetails(invalidId, 5)();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.message).toBe(`Phase ${invalidId} not found`);
      }
    });

    it('should handle invalid limit', async () => {
      const validId = 1 as PhaseId;
      const result = await workflows.getPhaseDetails(validId, -1)();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.message).toBe('Invalid event ID provided');
      }
    });
  });
});
