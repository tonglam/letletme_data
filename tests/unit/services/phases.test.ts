import * as E from 'fp-ts/Either';
import { createValidationError } from '../../../src/infrastructure/http/common/errors';
import { createPhaseService } from '../../../src/services/phases';
import { phaseWorkflows } from '../../../src/services/phases/workflow';
import type { Phase } from '../../../src/types/domain/phases.type';
import { PhaseId } from '../../../src/types/domain/phases.type';

const mockPhases: Phase[] = [
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
  {
    id: 3 as PhaseId,
    name: 'Phase 3',
    startEvent: 21,
    stopEvent: 30,
    highestScore: null,
  },
];

const mockBootstrapApi = {
  getBootstrapData: jest.fn(),
  getBootstrapEvents: jest.fn(),
};

let phaseService: ReturnType<typeof createPhaseService>;

jest.mock('../../../src/services/phases', () => {
  return {
    createPhaseService: jest.fn(() => ({
      syncPhases: jest.fn(() => async () => {
        const bootstrapData = await mockBootstrapApi.getBootstrapData();
        const sortedPhases = bootstrapData
          .slice()
          .sort((a: Phase, b: Phase) => a.startEvent - b.startEvent);
        for (let i = 1; i < sortedPhases.length; i++) {
          if (sortedPhases[i].startEvent <= sortedPhases[i - 1].stopEvent) {
            return E.left(
              createValidationError({
                message: 'Phase sequence invalid: overlapping phases detected',
              }),
            );
          }
        }
        return E.right(bootstrapData);
      }),

      getPhases: jest.fn(() => () => Promise.resolve(E.right(mockPhases))),

      getPhase: jest.fn((id: PhaseId) => () => {
        const phase = mockPhases.find((p) => p.id === id);
        return Promise.resolve(E.right(phase || null));
      }),

      getCurrentActivePhase: jest.fn((eventId: number) => () => {
        const phase = mockPhases.find((p) => eventId >= p.startEvent && eventId <= p.stopEvent);
        return Promise.resolve(E.right(phase || null));
      }),
    })),
  };
});

describe('Phase Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    phaseService = createPhaseService(mockBootstrapApi);
  });

  describe('syncPhases', () => {
    test('should sync phases successfully', async () => {
      mockBootstrapApi.getBootstrapData.mockResolvedValue(mockPhases);

      const result = await phaseService.syncPhases()();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual(mockPhases);
      }
    });

    test('should validate phase sequence', async () => {
      const invalidPhases: Phase[] = [
        {
          id: 1 as PhaseId,
          name: 'Phase 1',
          startEvent: 1,
          stopEvent: 15,
          highestScore: null,
        },
        {
          id: 2 as PhaseId,
          name: 'Phase 2',
          startEvent: 10,
          stopEvent: 20,
          highestScore: null,
        },
      ];
      mockBootstrapApi.getBootstrapData.mockResolvedValue(invalidPhases);

      const result = await phaseService.syncPhases()();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe('VALIDATION_ERROR');
        expect(result.left.message).toBe('Phase sequence invalid: overlapping phases detected');
      }
    });
  });

  describe('getPhases', () => {
    test('should get all phases', async () => {
      const result = await phaseService.getPhases()();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual(mockPhases);
      }
    });
  });

  describe('getPhase', () => {
    test('should get specific phase', async () => {
      const result = await phaseService.getPhase(1 as PhaseId)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual(mockPhases[0]);
      }
    });

    test('should return null for non-existent phase', async () => {
      const result = await phaseService.getPhase(999 as PhaseId)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toBeNull();
      }
    });
  });

  describe('getCurrentActivePhase', () => {
    test('should get active phase for event', async () => {
      const result = await phaseService.getCurrentActivePhase(5)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual(mockPhases[0]);
      }
    });

    test('should return null for event outside any phase', async () => {
      const result = await phaseService.getCurrentActivePhase(999)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toBeNull();
      }
    });
  });
});

describe('Phase Workflows', () => {
  let workflows: ReturnType<typeof phaseWorkflows>;

  beforeEach(() => {
    workflows = phaseWorkflows(phaseService);
  });

  describe('syncAndVerifyPhases', () => {
    test('should sync and verify phases successfully', async () => {
      mockBootstrapApi.getBootstrapData.mockResolvedValue(mockPhases);

      const result = await workflows.syncAndVerifyPhases()();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual(mockPhases);
      }
    });

    test('should fail if phases are invalid', async () => {
      const invalidPhases: Phase[] = [
        {
          id: 1 as PhaseId,
          name: 'Phase 1',
          startEvent: 1,
          stopEvent: 15,
          highestScore: null,
        },
        {
          id: 2 as PhaseId,
          name: 'Phase 2',
          startEvent: 10,
          stopEvent: 20,
          highestScore: null,
        },
      ];
      mockBootstrapApi.getBootstrapData.mockResolvedValue(invalidPhases);

      const result = await workflows.syncAndVerifyPhases()();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe('VALIDATION_ERROR');
        expect(result.left.message).toBe(
          'Phase sync failed: Phase sequence invalid: overlapping phases detected',
        );
      }
    });
  });

  describe('getPhaseDetails', () => {
    test('should get phase details with active status', async () => {
      const result = await workflows.getPhaseDetails(1 as PhaseId, 5)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right.phase).toEqual(mockPhases[0]);
        expect(result.right.isActive).toBe(true);
      }
    });

    test('should fail for non-existent phase', async () => {
      const result = await workflows.getPhaseDetails(999 as PhaseId, 5)();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe('VALIDATION_ERROR');
        expect(result.left.message).toBe('Phase 999 not found');
      }
    });

    test('should get phase details with inactive status for event outside phase boundaries', async () => {
      const result = await workflows.getPhaseDetails(1 as PhaseId, 15)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right.phase).toEqual(mockPhases[0]);
        expect(result.right.isActive).toBe(false);
      }
    });
  });
});
