// External dependencies
import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';

// Internal dependencies
import { APIError, createValidationError } from '../../infrastructure/http/common/errors';
import {
  PhaseRepository,
  PrismaPhase,
  validateEventId,
  validatePhaseId,
} from '../../types/phases.type';

/**
 * Retrieves all phases from the repository
 * @param repository - The phase repository instance
 * @returns TaskEither with array of phases or error
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getAllPhases = (repository: PhaseRepository): TE.TaskEither<APIError, PrismaPhase[]> =>
  repository.findAll();

/**
 * Retrieves a specific phase by its ID
 * @param repository - The phase repository instance
 * @param id - The phase ID to find
 * @returns TaskEither with phase or null if not found
 * @throws APIError with VALIDATION_ERROR code if ID is invalid
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getPhaseById = (
  repository: PhaseRepository,
  id: number,
): TE.TaskEither<APIError, PrismaPhase | null> =>
  pipe(
    validatePhaseId(id),
    E.mapLeft((message) => createValidationError({ message })),
    TE.fromEither,
    TE.chain(repository.findById),
  );

/**
 * Finds the current active phase based on event ID
 * @param repository - The phase repository instance
 * @param currentEventId - The current event ID to check against phase ranges
 * @returns TaskEither with current phase or null if not found
 * @throws APIError with VALIDATION_ERROR code if event ID is invalid
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getCurrentPhase = (
  repository: PhaseRepository,
  currentEventId: number,
): TE.TaskEither<APIError, PrismaPhase | null> =>
  pipe(
    validateEventId(currentEventId),
    E.mapLeft((message) => createValidationError({ message })),
    TE.fromEither,
    TE.chain((validEventId) =>
      pipe(
        repository.findAll(),
        TE.map((phases) =>
          pipe(
            phases,
            A.findFirst(
              (phase) => phase.startEvent <= validEventId && phase.stopEvent >= validEventId,
            ),
            O.toNullable,
          ),
        ),
      ),
    ),
  );
