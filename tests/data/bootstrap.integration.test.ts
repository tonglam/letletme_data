import * as E from 'fp-ts/Either';
import type { Logger } from 'pino';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFPLClient } from '../../../../../src/infrastructures/http/fpl/client';
import type { BootstrapEndpoints } from '../../../../../src/infrastructures/http/fpl/types';
import { createLogger, LOG_CONFIG } from '../../src/configs/logger/logger.config';
import { BootStrapResponseSchema } from '../../src/data/fpl/schemas/bootstrap/bootstrap.schema';

// Increase timeout for network requests
const TEST_TIMEOUT = 30000; // 30 seconds

describe('Integration Test: getBootstrapStatic', () => {
  let bootstrapEndpoints: BootstrapEndpoints;
  let logger: Logger;

  beforeAll(() => {
    // Initialize necessary dependencies
    const loggerConfig = {
      ...LOG_CONFIG.loggers.fpl, // Use fpl logger config
      level: LOG_CONFIG.level,
      filepath: LOG_CONFIG.path,
    };
    logger = createLogger(loggerConfig);

    // Simpler approach: Use the existing createFPLClient which sets up everything
    const fplEndpoints = createFPLClient(); // Use the main factory
    bootstrapEndpoints = fplEndpoints.bootstrap; // Extract bootstrap endpoints
  });

  it(
    'should fetch and return valid bootstrap data from the live FPL API using getBootstrapStatic',
    async () => {
      try {
        // Call the correct endpoint method
        const resultEither = await bootstrapEndpoints.getBootstrapStatic();

        // Expect the result to be a Right (success)
        expect(E.isRight(resultEither)).toBe(true);

        if (E.isRight(resultEither)) {
          const result = resultEither.right;

          // 1. Validate the structure against the Zod schema (already done inside the endpoint function, but good practice to double-check)
          const validationResult = BootStrapResponseSchema.safeParse(result);
          expect(
            validationResult.success,
            `Bootstrap data validation failed: ${
              validationResult.success ? '' : JSON.stringify(validationResult.error.issues)
            }`,
          ).toBe(true);

          // 2. Perform basic checks on the validated data
          if (validationResult.success) {
            const data = validationResult.data;
            expect(data).toBeDefined();
            expect(Array.isArray(data.events)).toBe(true);
            expect(data.events.length).toBeGreaterThan(0); // Should have at least one event
            expect(Array.isArray(data.teams)).toBe(true);
            expect(data.teams.length).toBeGreaterThan(0); // Should have teams
            expect(Array.isArray(data.elements)).toBe(true);
            expect(data.elements.length).toBeGreaterThan(0); // Should have players
            expect(Array.isArray(data.element_types)).toBe(true);
            expect(data.element_types.length).toBeGreaterThan(0); // Should have player types
            expect(Array.isArray(data.phases)).toBe(true); // Phases might be empty early season, but should exist
          }
        } else {
          // Log the Left value (error) for debugging if the test fails
          logger.error({ error: resultEither.left }, 'getBootstrapStatic returned Left');
          // Force fail if it's Left
          expect(resultEither.left).toBeUndefined();
        }
      } catch (error: unknown) {
        // Log the error for debugging but fail the test
        logger.error({ error }, 'Error during getBootstrapStatic test execution');
        // Make the test fail explicitly if an error occurs
        expect(error).toBeUndefined();
      }
    },
    TEST_TIMEOUT,
  ); // Apply increased timeout
});
