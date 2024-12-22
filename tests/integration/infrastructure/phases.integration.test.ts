import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';

import { phaseRepository } from '../../../src/domains/phases/repository';
import { APIError } from '../../../src/infrastructure/api/common/errors';
import { createFPLClient } from '../../../src/infrastructure/api/fpl';
import { connectDB, disconnectDB } from '../../../src/infrastructure/db/prisma';
import { createPhaseService } from '../../../src/services/phases';
import { phaseWorkflows } from '../../../src/services/phases/workflow';
import { PhaseId, toDomainPhase, validatePhaseId } from '../../../src/types/phase.type';

describe('Phase Service Integration', () => {
  const TEST_EVENT_ID = 15; // Mid-season event for reliable phase testing
  let phaseService: ReturnType<typeof createPhaseService>;
  let workflows: ReturnType<typeof phaseWorkflows>;
  let firstPhaseId: PhaseId;

  const handleError = (error: APIError): never => {
    process.stderr.write(
      `Error occurred: ${JSON.stringify(
        {
          message: error.message,
          code: error.code,
          details: error.details,
        },
        null,
        2,
      )}\n`,
    );
    throw new Error(`Operation failed: ${error.message}`);
  };

  beforeAll(async () => {
    try {
      // Force cleanup any existing connections
      await disconnectDB();
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Longer wait to ensure cleanup

      // Establish new database connection with retries
      let retries = 3;
      let connectionResult = E.left(new Error('Initial connection attempt')) as E.Either<
        Error,
        void
      >;
      let lastError: Error | undefined;

      while (retries > 0) {
        connectionResult = await connectDB();
        if (E.isRight(connectionResult)) break;

        lastError = connectionResult.left;
        retries--;
        if (retries > 0) {
          await disconnectDB(); // Force cleanup before retry
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      if (!connectionResult || E.isLeft(connectionResult)) {
        throw new Error(
          `Failed to connect to database after retries: ${lastError?.message || 'Unknown error'}`,
        );
      }

      // Clean existing data with error handling
      const cleanupResult = await pipe(
        phaseRepository.deleteAll(),
        TE.mapLeft((error) => {
          throw new Error(`Failed to clean database: ${error.message}`);
        }),
      )();

      if (E.isLeft(cleanupResult)) {
        throw cleanupResult.left;
      }

      // Initialize FPL client
      const fplClient = await pipe(
        createFPLClient()(),
        E.getOrElseW((error) => {
          throw new Error(`FPL client initialization failed: ${error.message}`);
        }),
      );

      // Initialize phase service
      phaseService = createPhaseService({
        getBootstrapData: async () => {
          const bootstrapResult = await fplClient.getBootstrapStatic();
          if (E.isLeft(bootstrapResult)) {
            throw new Error(`Failed to get bootstrap data: ${bootstrapResult.left.message}`);
          }
          const { phases } = bootstrapResult.right;
          const domainPhases = phases
            .map((p) => toDomainPhase(p))
            .filter(E.isRight)
            .map((p) => p.right);

          if (domainPhases.length === 0) {
            throw new Error('No phases data available');
          }
          return domainPhases;
        },
      });

      // Initialize workflows
      workflows = phaseWorkflows(phaseService);
    } catch (error) {
      await disconnectDB();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      throw error;
    }
  }, 30000);

  afterAll(async () => {
    try {
      // Force cleanup before final operations
      await disconnectDB();
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Clean up data with error handling
      const cleanupResult = await pipe(
        phaseRepository.deleteAll(),
        TE.mapLeft((error) => {
          process.stderr.write(`Warning: Failed to clean database: ${error.message}\n`);
          return error;
        }),
      )();

      if (E.isLeft(cleanupResult)) {
        process.stderr.write(`Warning: Database cleanup failed: ${cleanupResult.left.message}\n`);
      }
    } finally {
      // Multiple disconnect attempts to ensure cleanup
      for (let i = 0; i < 3; i++) {
        const disconnectResult = await disconnectDB();
        if (E.isRight(disconnectResult)) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }, 10000);

  describe('Phase Service Workflows', () => {
    test('1. should sync and verify phases', async () => {
      // When: running sync and verify workflow
      const syncResult = await workflows.syncAndVerifyPhases()();
      expect(E.isRight(syncResult)).toBe(true);

      const phases = pipe(
        syncResult,
        E.fold(handleError, (phases) => phases),
      );
      expect(phases.length).toBeGreaterThan(0);

      // Store first phase ID for subsequent tests
      const phaseIdResult = validatePhaseId(phases[0].id);
      expect(E.isRight(phaseIdResult)).toBe(true);
      if (E.isLeft(phaseIdResult)) throw new Error(`Invalid phase ID: ${phaseIdResult.left}`);
      firstPhaseId = phaseIdResult.right;
    }, 30000);

    test('2. should get phase details with active status', async () => {
      const detailsResult = await workflows.getPhaseDetails(firstPhaseId, TEST_EVENT_ID)();
      expect(E.isRight(detailsResult)).toBe(true);

      const details = pipe(
        detailsResult,
        E.fold(handleError, (details) => details),
      );

      expect(details.phase.id).toBe(firstPhaseId);
      expect(typeof details.isActive).toBe('boolean');
    }, 10000);
  });
});
