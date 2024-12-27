// External dependencies
import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';

// Internal dependencies
import { APIError, createValidationError } from '../../infrastructure/http/common/errors';
import { EventRepository, PrismaEvent, validateEventId } from '../../types/events.type';

/**
 * Retrieves all events from the repository
 * @param repository - The event repository instance
 * @returns TaskEither with array of events or error
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getAllEvents = (repository: EventRepository): TE.TaskEither<APIError, PrismaEvent[]> =>
  repository.findAll();

/**
 * Retrieves a specific event by its ID
 * @param repository - The event repository instance
 * @param id - The event ID to find
 * @returns TaskEither with event or null if not found
 * @throws APIError with VALIDATION_ERROR code if ID is invalid
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getEventById = (
  repository: EventRepository,
  id: number,
): TE.TaskEither<APIError, PrismaEvent | null> =>
  pipe(
    validateEventId(id),
    E.mapLeft((message) => createValidationError({ message })),
    TE.fromEither,
    TE.chain(repository.findById),
  );

/**
 * Retrieves the current active event
 * @param repository - The event repository instance
 * @returns TaskEither with current event or null if not found
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getCurrentEvent = (
  repository: EventRepository,
): TE.TaskEither<APIError, PrismaEvent | null> => repository.findCurrent();

/**
 * Retrieves the next upcoming event
 * @param repository - The event repository instance
 * @returns TaskEither with next event or null if not found
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getNextEvent = (
  repository: EventRepository,
): TE.TaskEither<APIError, PrismaEvent | null> => repository.findNext();

/**
 * Retrieves multiple events by their IDs
 * @param repository - The event repository instance
 * @param ids - Array of event IDs to find
 * @returns TaskEither with array of found events or error
 * @throws APIError with VALIDATION_ERROR code if any ID is invalid
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getEventsByIds = (
  repository: EventRepository,
  ids: number[],
): TE.TaskEither<APIError, PrismaEvent[]> =>
  pipe(
    ids,
    A.traverse(E.Applicative)((id: number) => validateEventId(id)),
    E.mapLeft((message: string) => createValidationError({ message })),
    TE.fromEither,
    TE.chain(repository.findByIds),
  );
