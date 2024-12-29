import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';

import { phaseRepository } from '../../../src/domains/phases/repository';
import { connectDB, disconnectDB } from '../../../src/infrastructure/db/prisma';
import { createPhaseService } from '../../../src/services/phases';
import { phaseWorkflows } from '../../../src/services/phases/workflow';
import { Phase, PhaseId, validatePhaseId } from '../../../src/types/domain/phases.type';
import { APIError } from '../../../src/types/errors.type';

const TEST_EVENT_ID = 21; // Event ID outside any phase boundary
const TEST_PHASES: Phase[] = [
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
];

describe('Phase Service Integration', () => {
  let phaseService: ReturnType<typeof createPhaseService>;
  let workflows: ReturnType<typeof phaseWorkflows>;

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

      // Initialize phase service with mock bootstrap data
      phaseService = createPhaseService({
        getBootstrapData: async () => ({
          teams: [],
          phases: TEST_PHASES.map((p) => ({
            id: p.id,
            name: p.name,
            start_event: p.startEvent,
            stop_event: p.stopEvent,
          })),
          events: [],
        }),
      });

      // Initialize workflows
      workflows = phaseWorkflows(phaseService);
    } catch (error) {
      await disconnectDB();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      throw error;
    }
  }, 30000);

  beforeEach(async () => {
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
  });

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
      expect(phases.length).toBe(TEST_PHASES.length);
      expect(phases[0]).toEqual(TEST_PHASES[0]);
    }, 30000);

    test('2. should get phase details with active status', async () => {
      // First sync phases
      await workflows.syncAndVerifyPhases()();

      // Then get details for Phase 1 with event in Phase 1
      const phaseIdResult = validatePhaseId(TEST_PHASES[0].id);
      expect(E.isRight(phaseIdResult)).toBe(true);
      if (E.isLeft(phaseIdResult)) throw new Error(`Invalid phase ID: ${phaseIdResult.left}`);

      const detailsResult = await workflows.getPhaseDetails(phaseIdResult.right, 5)();
      expect(E.isRight(detailsResult)).toBe(true);

      const details = pipe(
        detailsResult,
        E.fold(handleError, (details) => details),
      );

      expect(details.phase).toEqual(TEST_PHASES[0]);
      expect(details.isActive).toBe(true); // Event ID 5 is in Phase 1
    }, 10000);

    test('3. should validate phase boundaries', async () => {
      // First sync phases
      await workflows.syncAndVerifyPhases()();

      // Then get details for Phase 1 with event in Phase 2
      const phaseIdResult = validatePhaseId(TEST_PHASES[0].id);
      expect(E.isRight(phaseIdResult)).toBe(true);
      if (E.isLeft(phaseIdResult)) throw new Error(`Invalid phase ID: ${phaseIdResult.left}`);

      const detailsResult = await workflows.getPhaseDetails(phaseIdResult.right, TEST_EVENT_ID)();
      expect(E.isLeft(detailsResult)).toBe(true);
      if (E.isRight(detailsResult)) throw new Error('Expected validation error');

      expect(detailsResult.left.code).toBe('VALIDATION_ERROR');
      expect(detailsResult.left.message).toBe('Event ID outside phase boundaries');
    }, 10000);
  });
});
