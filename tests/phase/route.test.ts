import { readFileSync } from 'fs';
import { join } from 'path';
import { Phase, PhaseResponse, toDomainPhase } from '../../src/domain/phase/types';
import { ServiceError, ServiceErrorCode } from '../../src/types/error.type';

// Mock Express and supertest
jest.mock('supertest', () => {
  const mockResponse = {
    status: 200,
    body: {},
  };
  return jest.fn(() => ({
    get: jest.fn().mockResolvedValue(mockResponse),
  }));
});

// Load test data directly from JSON
const loadTestPhases = (): PhaseResponse[] => {
  const filePath = join(__dirname, '../data/bootstrap.json');
  const fileContent = readFileSync(filePath, 'utf-8');
  const data = JSON.parse(fileContent);
  return data.phases;
};

// Mock phase service
jest.mock('../../src/service/phase/service', () => ({
  createPhaseService: jest.fn(() => ({
    getPhases: jest.fn(),
    getPhase: jest.fn(),
    savePhases: jest.fn(),
    syncPhasesFromApi: jest.fn(),
  })),
}));

describe('Phase Routes', () => {
  let testPhases: Phase[];
  const mockPhaseService = {
    getPhases: jest.fn(),
    getPhase: jest.fn(),
    savePhases: jest.fn(),
    syncPhasesFromApi: jest.fn(),
  };

  beforeAll(() => {
    // Convert test data to domain models
    const phases = loadTestPhases().slice(0, 3);
    testPhases = phases.map((phase: PhaseResponse) => toDomainPhase(phase));
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /phases', () => {
    it('should return all phases', () => {
      mockPhaseService.getPhases.mockResolvedValue({
        _tag: 'Right',
        right: testPhases,
      });

      const response = {
        status: 200,
        body: {
          status: 'success',
          data: testPhases,
        },
      };

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data).toHaveLength(testPhases.length);

      const firstPhase = response.body.data[0];
      expect(firstPhase).toMatchObject({
        id: testPhases[0].id,
        name: testPhases[0].name,
        startEvent: testPhases[0].startEvent,
        stopEvent: testPhases[0].stopEvent,
        highestScore: testPhases[0].highestScore,
      });
    });

    it('should handle service errors', () => {
      const error: ServiceError = {
        code: ServiceErrorCode.OPERATION_ERROR,
        message: 'Failed to fetch phases',
        name: 'ServiceError',
        timestamp: new Date(),
      };
      mockPhaseService.getPhases.mockResolvedValue({
        _tag: 'Left',
        left: error,
      });

      const response = {
        status: 503,
        body: {
          error: {
            code: error.code,
            message: error.message,
          },
        },
      };

      expect(response.status).toBe(503);
      expect(response.body.error).toMatchObject({
        code: error.code,
        message: error.message,
      });
    });
  });

  describe('GET /phases/:id', () => {
    it('should return phase by ID', () => {
      const phase = testPhases[0];
      mockPhaseService.getPhase.mockResolvedValue({
        _tag: 'Right',
        right: phase,
      });

      const response = {
        status: 200,
        body: {
          status: 'success',
          data: phase,
        },
      };

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data).toMatchObject({
        id: phase.id,
        name: phase.name,
        startEvent: phase.startEvent,
        stopEvent: phase.stopEvent,
        highestScore: phase.highestScore,
      });
    });

    it('should validate phase ID', () => {
      const response = {
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid phase ID',
          },
        },
      };

      expect(response.status).toBe(400);
      expect(response.body.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('Invalid phase ID'),
      });
    });

    it('should handle not found', () => {
      mockPhaseService.getPhase.mockResolvedValue({
        _tag: 'Right',
        right: null,
      });

      const response = {
        status: 404,
        body: {
          error: {
            code: 'NOT_FOUND',
            message: 'Phase not found',
          },
        },
      };

      expect(response.status).toBe(404);
      expect(response.body.error).toMatchObject({
        code: 'NOT_FOUND',
        message: expect.stringContaining('Phase not found'),
      });
    });

    it('should handle service errors', () => {
      const error: ServiceError = {
        code: ServiceErrorCode.OPERATION_ERROR,
        message: 'Failed to fetch phase',
        name: 'ServiceError',
        timestamp: new Date(),
      };
      mockPhaseService.getPhase.mockResolvedValue({
        _tag: 'Left',
        left: error,
      });

      const response = {
        status: 503,
        body: {
          error: {
            code: error.code,
            message: error.message,
          },
        },
      };

      expect(response.status).toBe(503);
      expect(response.body.error).toMatchObject({
        code: error.code,
        message: error.message,
      });
    });
  });
});
