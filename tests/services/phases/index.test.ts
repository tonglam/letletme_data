import * as E from 'fp-ts/Either';
import { createPhaseService } from '../../../src/services/phases';
import { createValidationError } from '../../../src/infrastructure/api/common/errors';
import type { Phase } from '../../../src/types/phase.type';
import { PhaseId } from '../../../src/types/phase.type';

jest.mock('../../../src/services/phases', () => ({
  createPhaseService: jest.fn(() => ({
    syncPhases: jest.fn(() => () => Promise.resolve(E.right([]))),
    getPhases: jest.fn(() => () => Promise.resolve(E.right([]))),
    getPhase: jest.fn(() => () => Promise.resolve(E.right(null))),
    getCurrentActivePhase: jest.fn(() => () => Promise.resolve(E.right(null))),
  })),
}));

describe('Phase Service', () => {
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
  ];

  const mockBootstrapApi = {
    getBootstrapData: jest.fn(),
  };

  let phaseService: ReturnType<typeof createPhaseService>;

  beforeEach(() => {
    jest.clearAllMocks();
    phaseService = createPhaseService(mockBootstrapApi);
    (phaseService.syncPhases as jest.Mock).mockImplementation(() => () => Promise.resolve(E.right(mockPhases)));
    (phaseService.getPhases as jest.Mock).mockImplementation(() => () => Promise.resolve(E.right(mockPhases)));
    (phaseService.getPhase as jest.Mock).mockImplementation(() => () => Promise.resolve(E.right(mockPhases[0])));
    (phaseService.getCurrentActivePhase as jest.Mock).mockImplementation(() => () => Promise.resolve(E.right(mockPhases[0])));
  });

  describe('syncPhases', () => {
    it('should successfully sync phases when API returns data', async () => {
      mockBootstrapApi.getBootstrapData.mockResolvedValueOnce(mockPhases);

      const result = await phaseService.syncPhases()();
      
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toHaveLength(2);
        expect(result.right[0]).toEqual(mockPhases[0]);
      }
    });

    it('should return error when API returns null', async () => {
      mockBootstrapApi.getBootstrapData.mockResolvedValueOnce(null);
      (phaseService.syncPhases as jest.Mock).mockImplementation(() => () => 
        Promise.resolve(E.left(createValidationError({ message: 'No phases data available from API' })))
      );

      const result = await phaseService.syncPhases()();
      
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left).toEqual(
          createValidationError({ message: 'No phases data available from API' })
        );
      }
    });

    it('should return error when API call fails', async () => {
      const error = new Error('API Error');
      mockBootstrapApi.getBootstrapData.mockRejectedValueOnce(error);
      (phaseService.syncPhases as jest.Mock).mockImplementation(() => () => 
        Promise.resolve(E.left(createValidationError({ message: `Failed to fetch bootstrap data: ${error}` })))
      );

      const result = await phaseService.syncPhases()();
      
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left).toEqual(
          createValidationError({ message: `Failed to fetch bootstrap data: ${error}` })
        );
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
      const result = await phaseService.getCurrentActivePhase(5)();
      
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual(mockPhases[0]);
      }
    });
  });
});
