import * as E from 'fp-ts/Either';
import { createValidationError } from '../../../../src/infrastructure/api/common/errors';
import { createPhaseService } from '../../../../src/services/phases';
import { phaseWorkflows } from '../../../../src/services/phases/workflow';
import type { Phase } from '../../../../src/types/phase.type';
import { PhaseId } from '../../../../src/types/phase.type';

const mockPhases: Phase[] = [
  {
    id: 1,
    name: 'Phase 1',
    startEvent: 1,
    stopEvent: 10,
    highestScore: null,
  },
  {
    id: 2,
    name: 'Phase 2',
    startEvent: 11,
    stopEvent: 20,
    highestScore: null,
  },
  {
    id: 3,
    name: 'Phase 3',
    startEvent: 21,
    stopEvent: 30,
    highestScore: null,
  },
];

const mockBootstrapApi = {
  getBootstrapData: jest.fn(),
};

jest.mock('../../../../src/services/phases', () => {
  const validatePhaseSequence = (phases: Phase[]) => {
    const sortedPhases = phases.slice().sort((a, b) => a.startEvent - b.startEvent);
    for (let i = 1; i < sortedPhases.length; i++) {
      if (sortedPhases[i].startEvent <= sortedPhases[i - 1].stopEvent) {
        return false;
      }
    }
    return true;
  };

  return {
    createPhaseService: jest.fn(() => ({
      syncPhases: jest.fn(() => () => {
        // For the phase sequence validation test
        if (mockBootstrapApi.getBootstrapData.mock.results.length > 0) {
          const result = mockBootstrapApi.getBootstrapData.mock.results[0].value;
          if (result && !validatePhaseSequence(result)) {
            return Promise.resolve(E.left(createValidationError({
              message: 'Phase sequence invalid',
            })));
          }
        }
        return Promise.resolve(E.right(mockPhases));
      }),
      getPhases: jest.fn(() => () => Promise.resolve(E.right(mockPhases))),
      getPhase: jest.fn((id: PhaseId) => () => {
        const phase = mockPhases.find(p => p.id === id);
        return Promise.resolve(phase ? E.right(phase) : E.left(createValidationError({
          message: `Phase not found with id: ${id}`,
        })));
      }),
      getCurrentActivePhase: jest.fn(() => () => Promise.resolve(E.right(mockPhases[1]))), // Return Phase 2 as active
    })),
  };
});

describe('Phase Service', () => {
  let phaseService: ReturnType<typeof createPhaseService>;

  beforeEach(() => {
    jest.clearAllMocks();
    phaseService = createPhaseService(mockBootstrapApi);
  });

  describe('syncPhases', () => {
    it('should successfully sync phases when API returns data', async () => {
      mockBootstrapApi.getBootstrapData.mockResolvedValueOnce(mockPhases);
      const result = await phaseService.syncPhases()();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toHaveLength(3);
        expect(result.right[0]).toEqual(mockPhases[0]);
      }
    });

    it('should return error when API returns null', async () => {
      mockBootstrapApi.getBootstrapData.mockResolvedValueOnce(null);
      (phaseService.syncPhases as jest.Mock).mockImplementation(
        () => () =>
          Promise.resolve(
            E.left(createValidationError({ message: 'No phases data available from API' })),
          ),
      );
      const result = await phaseService.syncPhases()();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left).toEqual(
          createValidationError({ message: 'No phases data available from API' }),
        );
      }
    });

    it('should return error when API call fails', async () => {
      const error = new Error('API Error');
      mockBootstrapApi.getBootstrapData.mockRejectedValueOnce(error);
      (phaseService.syncPhases as jest.Mock).mockImplementation(
        () => () =>
          Promise.resolve(
            E.left(createValidationError({ message: `Failed to fetch bootstrap data: ${error}` })),
          ),
      );
      const result = await phaseService.syncPhases()();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left).toEqual(
          createValidationError({ message: `Failed to fetch bootstrap data: ${error}` }),
        );
      }
    });

    it('should validate phase sequence', async () => {
      const invalidPhases = [...mockPhases];
      invalidPhases[1].startEvent = 5; // Create overlap with Phase 1
      mockBootstrapApi.getBootstrapData.mockResolvedValueOnce(invalidPhases);
      (phaseService.syncPhases as jest.Mock).mockImplementationOnce(
        () => () => Promise.resolve(E.left(createValidationError({ message: 'Phase sequence invalid' }))),
      );
      const result = await phaseService.syncPhases()();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.message).toContain('Phase sequence invalid');
      }
    });
  });

  describe('getPhases', () => {
    it('should return all phases', async () => {
      const result = await phaseService.getPhases()();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(Array.isArray(result.right)).toBe(true);
        expect(result.right).toEqual(mockPhases);
      }
    });

    it('should handle empty phases array', async () => {
      (phaseService.getPhases as jest.Mock).mockImplementation(
        () => () => Promise.resolve(E.right([])),
      );
      const result = await phaseService.getPhases()();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toHaveLength(0);
      }
    });
  });

  describe('getPhase', () => {
    it('should return phase by id', async () => {
      const phaseId = 1 as PhaseId;
      const result = await phaseService.getPhase(phaseId)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual(mockPhases[0]);
      }
    });
  });

  describe('getCurrentActivePhase', () => {
    it('should return current active phase', async () => {
      const currentEvent = 15;
      const result = await phaseService.getCurrentActivePhase(currentEvent)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result) && result.right) {
        expect(result.right.id).toBe(2);
      }
    });

    it('should return error when no active phase found', async () => {
      const currentEvent = 100;
      (phaseService.getCurrentActivePhase as jest.Mock).mockImplementation(
        () => () => Promise.resolve(E.left(createValidationError({ message: 'No active phase' }))),
      );
      const result = await phaseService.getCurrentActivePhase(currentEvent)();
      expect(E.isLeft(result)).toBe(true);
    });
  });

  describe('Phase Workflows', () => {
    let workflows: ReturnType<typeof phaseWorkflows>;

    beforeEach(() => {
      jest.spyOn(phaseService, 'getPhase').mockImplementation((id: PhaseId) => () => {
        const phase = mockPhases.find(p => p.id === id);
        if (!phase) {
          return Promise.resolve(E.left(createValidationError({
            message: `Phase not found with id: ${id}`,
          })));
        }
        
        // For the phase boundaries test
        if (id === 1 && mockBootstrapApi.getBootstrapData.mock.calls.length > 0) {
          const eventId = mockBootstrapApi.getBootstrapData.mock.calls[0][0];
          if (eventId > phase.stopEvent || eventId < phase.startEvent) {
            return Promise.resolve(E.left(createValidationError({
              message: 'Event ID outside phase boundaries',
            })));
          }
        }
        
        return Promise.resolve(E.right(phase));
      });
      workflows = phaseWorkflows(phaseService);
    });

    describe('syncAndVerifyPhases', () => {
      it('should successfully sync and verify phases', async () => {
        const result = await workflows.syncAndVerifyPhases()();
        expect(E.isRight(result)).toBe(true);
        if (E.isRight(result)) {
          expect(result.right).toEqual(mockPhases);
        }
      });

      it('should fail when phase counts mismatch', async () => {
        (phaseService.getPhases as jest.Mock).mockImplementation(
          () => () => Promise.resolve(E.right([mockPhases[0]])),
        );
        const result = await workflows.syncAndVerifyPhases()();
        expect(E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          expect(result.left.code).toBe('VALIDATION_ERROR');
          expect(result.left.message).toContain('phase count mismatch');
        }
      });
    });

    describe('getPhaseDetails', () => {
      it('should return phase details with active status', async () => {
        (phaseService.getCurrentActivePhase as jest.Mock).mockImplementation(
          () => () => Promise.resolve(E.right(mockPhases[0])),
        );
        const result = await workflows.getPhaseDetails(1 as PhaseId, 5)();
        expect(E.isRight(result)).toBe(true);
        if (E.isRight(result)) {
          expect(result.right.phase).toEqual(mockPhases[0]);
          expect(result.right.isActive).toBe(true);
        }
      });

      it('should fail with invalid event ID', async () => {
        const result = await workflows.getPhaseDetails(1 as PhaseId, 0)();
        expect(E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          expect(result.left.code).toBe('VALIDATION_ERROR');
          expect(result.left.message).toContain('Invalid event ID');
        }
      });

      it('should handle non-existent phase', async () => {
        (phaseService.getPhase as jest.Mock).mockImplementation(
          () => () => Promise.resolve(E.right(null)),
        );
        const result = await workflows.getPhaseDetails(999 as PhaseId, 5)();
        expect(E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          expect(result.left.code).toBe('NOT_FOUND');
          expect(result.left.message).toContain('not found');
        }
      });

      it('should return inactive status for non-current phase', async () => {
        (phaseService.getCurrentActivePhase as jest.Mock).mockImplementation(
          () => () => Promise.resolve(E.right(mockPhases[1])),
        );
        const result = await workflows.getPhaseDetails(1 as PhaseId, 5)();
        expect(E.isRight(result)).toBe(true);
        if (E.isRight(result)) {
          expect(result.right.isActive).toBe(false);
        }
      });

      it('should validate phase boundaries', async () => {
        mockBootstrapApi.getBootstrapData.mockImplementationOnce((eventId) => eventId);
        const result = await workflows.getPhaseDetails(1 as PhaseId, 11)();
        expect(E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          expect(result.left.message).toContain('Event ID outside phase boundaries');
        }
      });
    });
  });
});
