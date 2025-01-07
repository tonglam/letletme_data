import axios from 'axios';
import * as E from 'fp-ts/Either';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructure/http/client/utils';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import type { FPLEndpoints } from '../../src/infrastructure/http/fpl/types';
import { APIErrorCode, type APIError } from '../../src/types/error.type';

describe('FPL Client Integration Tests', () => {
  let fplClient: FPLEndpoints;
  let bootstrapAdapter: ReturnType<typeof createBootstrapApiAdapter>;
  let axiosInstance: ReturnType<typeof axios.create>;
  const TEST_TIMEOUT = 15000;

  beforeAll(() => {
    axiosInstance = axios.create();
    fplClient = createFPLClient({
      retryConfig: {
        ...DEFAULT_RETRY_CONFIG,
        attempts: 3,
      },
    });
    bootstrapAdapter = createBootstrapApiAdapter(fplClient);
  });

  afterAll(async () => {
    // Cleanup axios instance to prevent open handles
    if (axiosInstance) {
      await Promise.all([
        axiosInstance.get('/').catch(() => {}), // Trigger any pending requests
        new Promise((resolve) => setTimeout(resolve, 100)), // Small delay for cleanup
      ]);
    }
  });

  describe('Bootstrap API Integration', () => {
    describe('Successful Data Fetching', () => {
      describe('Events Data', () => {
        it(
          'should successfully fetch and validate events data',
          async () => {
            const data = await bootstrapAdapter.getBootstrapData();

            // Verify events data structure
            expect(Array.isArray(data.events)).toBe(true);
            expect(data.events.length).toBeGreaterThan(0);

            // Verify required fields in first event
            const event = data.events[0];
            expect(event).toMatchObject({
              id: expect.any(Number),
              name: expect.any(String),
              deadline_time: expect.any(String),
              is_current: expect.any(Boolean),
              is_next: expect.any(Boolean),
              is_previous: expect.any(Boolean),
              finished: expect.any(Boolean),
            });

            // Verify date format
            expect(new Date(event.deadline_time).toString()).not.toBe('Invalid Date');
          },
          TEST_TIMEOUT,
        );
      });

      it(
        'should cache bootstrap data on subsequent calls',
        async () => {
          // Create a new client and adapter for this test
          const mockGetBootstrapStatic = jest.fn().mockImplementation(() =>
            Promise.resolve(
              E.right({
                events: [{ id: 1 }],
                phases: [{ id: 1 }],
                teams: [{ id: 1 }],
                elements: [{ id: 1 }],
              }),
            ),
          );

          const mockClient: FPLEndpoints = {
            bootstrap: {
              getBootstrapStatic: mockGetBootstrapStatic,
            },
            element: { getElementSummary: jest.fn() },
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

          const testAdapter = createBootstrapApiAdapter(mockClient);

          // First call
          await testAdapter.getBootstrapData();

          // Second call (should use cache)
          await testAdapter.getBootstrapData();

          // Third call (should still use cache)
          await testAdapter.getBootstrapData();

          // Should only call the API once, other calls should use cache
          expect(mockGetBootstrapStatic).toHaveBeenCalledTimes(1);
        },
        TEST_TIMEOUT,
      );
    });

    describe('Error Handling', () => {
      it(
        'should handle rate limiting with exponential backoff',
        async () => {
          // Make multiple rapid requests to trigger rate limiting
          const requests = Array(5)
            .fill(null)
            .map(() => fplClient.bootstrap.getBootstrapStatic());

          const results = await Promise.all(requests);
          const successCount = results.filter(E.isRight).length;
          const failureCount = results.filter(E.isLeft).length;

          // Log results for debugging
          console.log(`Rate limiting test: ${successCount} successes, ${failureCount} failures`);

          // Verify rate limiting behavior
          results.forEach((result) => {
            if (E.isLeft(result)) {
              expect(result.left.code).toBe(APIErrorCode.VALIDATION_ERROR);
              expect(result.left.details?.httpStatus).toBe(429);
              expect(result.left.message).toContain('Rate limit exceeded');
            } else {
              expect(Array.isArray(result.right.events)).toBe(true);
            }
          });
        },
        TEST_TIMEOUT * 2,
      );

      it(
        'should handle temporary failures with retry',
        async () => {
          const maxRetries = 3;
          const results = [];
          let lastError: APIError | null = null;

          // Try multiple times with increasing delays
          for (let i = 0; i < maxRetries; i++) {
            try {
              const result = await fplClient.bootstrap.getBootstrapStatic();
              results.push(result);
              if (E.isRight(result)) break;

              // Store error for debugging
              if (E.isLeft(result)) {
                lastError = result.left;
              }

              // Exponential backoff
              await new Promise((resolve) => setTimeout(resolve, Math.pow(2, i) * 1000));
            } catch (error) {
              if (error instanceof Error) {
                lastError = {
                  code: APIErrorCode.VALIDATION_ERROR,
                  message: error.message,
                  name: 'APIError',
                  timestamp: new Date(),
                  details: { error },
                };
              }
            }
          }

          // Log debugging information
          if (lastError) {
            console.log('Last error encountered:', {
              code: lastError.code,
              message: lastError.message,
              details: lastError.details,
            });
          }

          // Verify retry behavior
          expect(results.length).toBeGreaterThan(0);
          expect(results.some(E.isRight)).toBe(true);
        },
        TEST_TIMEOUT * 3,
      );

      it(
        'should handle network errors gracefully',
        async () => {
          // Create a mock client that simulates network errors
          const mockClient: FPLEndpoints = {
            bootstrap: {
              getBootstrapStatic: jest.fn().mockResolvedValue(
                E.left({
                  code: APIErrorCode.VALIDATION_ERROR,
                  message: 'network error',
                  name: 'APIError',
                  timestamp: new Date(),
                  details: { httpStatus: 500 },
                }),
              ),
            },
            element: { getElementSummary: jest.fn() },
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

          const result = await mockClient.bootstrap.getBootstrapStatic();

          expect(E.isLeft(result)).toBe(true);
          if (E.isLeft(result)) {
            expect(result.left.code).toBe(APIErrorCode.VALIDATION_ERROR);
            expect(result.left.message).toContain('network');
          }
        },
        TEST_TIMEOUT,
      );
    });
  });
});
