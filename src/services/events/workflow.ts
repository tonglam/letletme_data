import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { APIError, createValidationError } from '../../infrastructure/http/common/errors';
import type { Event, EventId } from '../../types/events.type';
import type { EventService } from './types';

/**
 * Event Service Workflows
 * Provides high-level operations combining multiple event service operations
 */
export const eventWorkflows = (eventService: EventService) => {
  /**
   * Syncs events from API to local database
   * Existing data will be truncated and replaced with new data
   *
   * @returns TaskEither<APIError, readonly Event[]> - Success: synced events, Error: APIError
   */
  const syncAndVerifyEvents = (): TE.TaskEither<APIError, readonly Event[]> =>
    pipe(
      eventService.syncEvents(),
      TE.mapLeft((error) => ({
        ...error,
        message: `Event sync failed: ${error.message}`,
      })),
    );

  /**
   * Retrieves detailed event information and determines if it's currently active
   *
   * Validation checks:
   * 1. Confirms event exists
   * 2. Verifies if it's the current event
   *
   * The event is considered active if:
   * - It matches the currently active event
   *
   * @param eventId - Unique identifier of the event
   * @returns TaskEither with object containing:
   *         - event: The requested Event object
   *         - isActive: Boolean indicating if event is currently active
   */
  const getEventDetails = (
    eventId: EventId,
  ): TE.TaskEither<APIError, { event: Event; isActive: boolean }> =>
    pipe(
      eventService.getEvent(eventId),
      TE.chain((event) =>
        event === null
          ? TE.left(createValidationError({ message: `Event ${eventId} not found` }))
          : pipe(
              eventService.getCurrentEvent(),
              TE.map((currentEvent) => ({
                event,
                isActive: currentEvent?.id === event.id,
              })),
            ),
      ),
    );

  return {
    syncAndVerifyEvents,
    getEventDetails,
  } as const;
};

export type EventWorkflows = ReturnType<typeof eventWorkflows>;
