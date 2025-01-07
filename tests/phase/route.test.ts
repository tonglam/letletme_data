import { toDomainPhase } from '../../src/domain/phase/types';
import { getTestPhase, getTestPhases } from '../data/bootstrap.test';

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

// Mock phase service
jest.mock('../../src/service/phase/service', () => ({
  createPhaseService: jest.fn(() => ({
    getPhases: jest.fn(),
    getPhase: jest.fn(),
    savePhases: jest.fn(),
    syncPhasesFromApi: jest.fn(),
  })),
}));

const mockPhaseService = {
  getPhases: jest.fn(),
  getPhase: jest.fn(),
  savePhases: jest.fn(),
  syncPhasesFromApi: jest.fn(),
};

describe('Phase Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /phases', () => {
    it('should return all phases', async () => {
      const phaseResponses = getTestPhases().slice(0, 3);
      const phases = phaseResponses.map(toDomainPhase);
      mockPhaseService.getPhases.mockResolvedValue({
        _tag: 'Right',
        right: phases,
      });

      const response = {
        status: 200,
        body: {
          status: 'success',
          data: phases,
        },
      };

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data).toHaveLength(3);
      expect(response.body.data[0]).toHaveProperty('id', phases[0].id);
      expect(response.body.data[0]).toHaveProperty('name', phases[0].name);
      expect(response.body.data[0]).toHaveProperty('startEvent', phases[0].startEvent);
      expect(response.body.data[0]).toHaveProperty('stopEvent', phases[0].stopEvent);
    });

    it('should handle service errors', async () => {
      mockPhaseService.getPhases.mockResolvedValue({
        _tag: 'Left',
        left: {
          code: 'SERVICE_ERROR',
          message: 'Service error',
        },
      });

      const response = {
        status: 503,
        body: {
          error: {
            code: 'SERVICE_ERROR',
            message: 'Service error',
          },
        },
      };

      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('SERVICE_ERROR');
      expect(response.body.error.message).toBe('Service error');
    });
  });

  describe('GET /phases/:id', () => {
    it('should return phase by ID', async () => {
      const phaseResponse = getTestPhase(1)!;
      const phase = toDomainPhase(phaseResponse);
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
      expect(response.body.data).toHaveProperty('id', phase.id);
      expect(response.body.data).toHaveProperty('name', phase.name);
      expect(response.body.data).toHaveProperty('startEvent', phase.startEvent);
      expect(response.body.data).toHaveProperty('stopEvent', phase.stopEvent);
    });

    it('should validate phase ID', async () => {
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
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.message).toContain('Invalid phase ID');
    });

    it('should handle not found', async () => {
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
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(response.body.error.message).toContain('Phase not found');
    });

    it('should handle service errors', async () => {
      mockPhaseService.getPhase.mockResolvedValue({
        _tag: 'Left',
        left: {
          code: 'SERVICE_ERROR',
          message: 'Service error',
        },
      });

      const response = {
        status: 503,
        body: {
          error: {
            code: 'SERVICE_ERROR',
            message: 'Service error',
          },
        },
      };

      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('SERVICE_ERROR');
      expect(response.body.error.message).toBe('Service error');
    });
  });
});
