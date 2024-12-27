// External dependencies
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';

// Internal dependencies
import { APIError, createValidationError } from '../../infrastructure/http/common/errors';
import { PhaseRepository, PrismaPhase, validatePhaseId } from '../../types/phases.type';

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
