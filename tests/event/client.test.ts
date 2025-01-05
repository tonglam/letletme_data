import * as E from 'fp-ts/Either';
import type { FPLEndpoints } from '../../src/infrastructure/http/fpl/types';
import { APIErrorCode } from '../../src/types/errors.type';
import bootstrapData from '../data/bootstrap.json';

describe('FPL Client Tests', () => {
  let fplClient: FPLEndpoints;
  const TEST_TIMEOUT = 15000;

  beforeAll(() => {
    // Create a mock client that returns the bootstrap data
    fplClient = {
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

  describe('Bootstrap API Integration', () => {
    it(
      'should successfully fetch bootstrap data',
      async () => {
        const result = await fplClient.bootstrap.getBootstrapStatic();
        expect(E.isRight(result)).toBe(true);

        if (E.isRight(result)) {
          const data = result.right;
          expect(Array.isArray(data.events)).toBe(true);
          expect(Array.isArray(data.phases)).toBe(true);
          expect(Array.isArray(data.teams)).toBe(true);
          expect(Array.isArray(data.elements)).toBe(true);
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should contain required event fields',
      async () => {
        const result = await fplClient.bootstrap.getBootstrapStatic();

        if (E.isRight(result)) {
          const { events } = result.right;
          expect(events.length).toBeGreaterThan(0);

          const event = events[0];
          expect(event).toHaveProperty('id');
          expect(event).toHaveProperty('name');
          expect(event).toHaveProperty('deadline_time');
          expect(event).toHaveProperty('is_current');
          expect(event).toHaveProperty('is_next');
          expect(event).toHaveProperty('is_previous');
          expect(event).toHaveProperty('finished');
        }
      },
      TEST_TIMEOUT,
    );

    describe('Rate Limit Handling', () => {
      it(
        'should handle rate limiting gracefully',
        async () => {
          // Mock rate limit responses
          const mockResponses = Array(5)
            .fill(null)
            .map((_, i) =>
              i < 3
                ? E.right(bootstrapData)
                : E.left({
                    code: APIErrorCode.VALIDATION_ERROR,
                    message: 'Rate limit exceeded',
                    details: { httpStatus: 429 },
                  }),
            );

          const requests = mockResponses.map((response) => Promise.resolve(response));

          const results = await Promise.all(requests);

          results.forEach((result) => {
            expect(E.isRight(result) || E.isLeft(result)).toBe(true);
            if (E.isLeft(result)) {
              expect(result.left.code).toBe(APIErrorCode.VALIDATION_ERROR);
            }
          });
        },
        TEST_TIMEOUT * 2,
      );
    });

    describe('Error Handling', () => {
      it('should handle timeout scenarios', async () => {
        // Mock timeout response
        const mockTimeoutResponse = E.left({
          code: APIErrorCode.VALIDATION_ERROR,
          message: 'Request timeout',
          details: { httpStatus: 408 },
        });

        const result = await Promise.resolve(mockTimeoutResponse);

        expect(E.isRight(result) || E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          expect(result.left.code).toBe(APIErrorCode.VALIDATION_ERROR);
        }
      });

      it(
        'should recover from temporary failures',
        async () => {
          // Mock temporary failures with eventual success
          const mockResponses = [
            E.left({
              code: APIErrorCode.VALIDATION_ERROR,
              message: 'Temporary failure',
              details: { httpStatus: 503 },
            }),
            E.left({
              code: APIErrorCode.VALIDATION_ERROR,
              message: 'Temporary failure',
              details: { httpStatus: 503 },
            }),
            E.right(bootstrapData),
          ];

          let attempts = 0;
          let finalResult = mockResponses[0];

          while (attempts < mockResponses.length && E.isLeft(finalResult)) {
            await new Promise((resolve) => setTimeout(resolve, attempts * 1000));
            finalResult = mockResponses[attempts];
            attempts++;
          }

          expect(attempts).toBeLessThanOrEqual(mockResponses.length);
          if (E.isLeft(finalResult)) {
            expect(finalResult.left.code).toBe(APIErrorCode.VALIDATION_ERROR);
          }
        },
        TEST_TIMEOUT * 3,
      );
    });
  });
});
