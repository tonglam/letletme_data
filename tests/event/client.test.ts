import * as E from 'fp-ts/Either';
import type { FPLEndpoints } from '../../src/infrastructure/http/fpl/types';
import { APIErrorCode } from '../../src/types/errors.type';
import bootstrapData from '../data/bootstrap.json';

describe('FPL Client Mock Tests', () => {
  let mockClient: FPLEndpoints;

  beforeEach(() => {
    // Create a mock client that returns the bootstrap data
    mockClient = {
      bootstrap: {
        getBootstrapStatic: jest.fn().mockResolvedValue(E.right(bootstrapData)),
      },
      element: {
        getElementSummary: jest.fn(),
      },
      entry: {
        getEntry: jest.fn(),
        getEntryTransfers: jest.fn(),
        getEntryHistory: jest.fn(),
      },
      event: {
        getLive: jest.fn(),
        getPicks: jest.fn(),
        getFixtures: jest.fn(),
      },
      leagues: {
        getClassicLeague: jest.fn(),
        getH2hLeague: jest.fn(),
        getCup: jest.fn(),
      },
    };
  });

  describe('Bootstrap Data Tests', () => {
    it('should return mock bootstrap data', async () => {
      const result = await mockClient.bootstrap.getBootstrapStatic();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        const data = result.right;
        // Verify data structure
        expect(Array.isArray(data.events)).toBe(true);
        expect(Array.isArray(data.phases)).toBe(true);
        expect(Array.isArray(data.teams)).toBe(true);
        expect(Array.isArray(data.elements)).toBe(true);
        // Verify mock data matches
        expect(data).toEqual(bootstrapData);
      }
    });

    it('should validate required fields in mock data', async () => {
      const result = await mockClient.bootstrap.getBootstrapStatic();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        const { events } = result.right;
        expect(events.length).toBeGreaterThan(0);

        const event = events[0];
        expect(event).toMatchObject({
          id: expect.any(Number),
          name: expect.any(String),
          deadline_time: expect.any(String),
          is_current: expect.any(Boolean),
          is_next: expect.any(Boolean),
          is_previous: expect.any(Boolean),
          finished: expect.any(Boolean),
        });
      }
    });
  });

  describe('Error Handling Tests', () => {
    it('should handle rate limit errors', async () => {
      // Mock rate limit error
      (mockClient.bootstrap.getBootstrapStatic as jest.Mock).mockResolvedValueOnce(
        E.left({
          code: APIErrorCode.VALIDATION_ERROR,
          message: 'Rate limit exceeded',
          details: { httpStatus: 429 },
        }),
      );

      const result = await mockClient.bootstrap.getBootstrapStatic();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(APIErrorCode.VALIDATION_ERROR);
        expect(result.left.details?.httpStatus).toBe(429);
      }
    });

    it('should handle timeout errors', async () => {
      // Mock timeout error
      (mockClient.bootstrap.getBootstrapStatic as jest.Mock).mockResolvedValueOnce(
        E.left({
          code: APIErrorCode.VALIDATION_ERROR,
          message: 'Request timeout',
          details: { httpStatus: 408 },
        }),
      );

      const result = await mockClient.bootstrap.getBootstrapStatic();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(APIErrorCode.VALIDATION_ERROR);
        expect(result.left.details?.httpStatus).toBe(408);
      }
    });

    it('should handle retry and recovery', async () => {
      // Mock sequence: error, error, success
      (mockClient.bootstrap.getBootstrapStatic as jest.Mock)
        .mockResolvedValueOnce(
          E.left({
            code: APIErrorCode.VALIDATION_ERROR,
            message: 'Temporary failure',
            details: { httpStatus: 503 },
          }),
        )
        .mockResolvedValueOnce(
          E.left({
            code: APIErrorCode.VALIDATION_ERROR,
            message: 'Temporary failure',
            details: { httpStatus: 503 },
          }),
        )
        .mockResolvedValueOnce(E.right(bootstrapData));

      // First call - should fail
      let result = await mockClient.bootstrap.getBootstrapStatic();
      expect(E.isLeft(result)).toBe(true);

      // Second call - should fail
      result = await mockClient.bootstrap.getBootstrapStatic();
      expect(E.isLeft(result)).toBe(true);

      // Third call - should succeed
      result = await mockClient.bootstrap.getBootstrapStatic();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual(bootstrapData);
      }

      // Verify mock was called three times
      expect(mockClient.bootstrap.getBootstrapStatic).toHaveBeenCalledTimes(3);
    });
  });
});
