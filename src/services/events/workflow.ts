import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { APIError } from '../../infrastructure/http/common/errors';
import { getWorkflowLogger } from '../../infrastructure/logger';
import type { Event } from '../../types/events.type';
import type { EventService } from './types';

const logger = getWorkflowLogger();

/**
 * Event Service Workflows
 * Provides high-level operations combining multiple event service operations
 */
export const eventWorkflows = (eventService: EventService) => {
  /**
   * Syncs events from FPL API to local database with following steps:
   * 1. Get events from API (includes validation and transformation)
   * 2. Save to database (clears existing data first)
   *
   * @returns TaskEither<APIError, readonly Event[]> - Success: synced events, Error: APIError
   */
  const syncEvents = (): TE.TaskEither<APIError, readonly Event[]> =>
    pipe(
      logger.info({ workflow: 'event-sync' }, 'Starting event sync'),
      () =>
        pipe(
          eventService.getEvents(),
          TE.mapLeft((error) => ({
            ...error,
            message: `Failed to fetch events: ${error.message}`,
          })),
        ),
      TE.chain((events) => {
        logger.info({ workflow: 'event-sync', count: events.length }, 'Syncing events to database');
        return pipe(
          eventService.saveToDb(events),
          TE.mapLeft((error) => ({
            ...error,
            message: `Failed to save events: ${error.message}`,
          })),
          TE.map((savedEvents) => {
            logger.info(
              { workflow: 'event-sync', count: savedEvents.length },
              'Successfully synced events',
            );
            return savedEvents;
          }),
        );
      }),
    );

  return {
    syncEvents,
  } as const;
};

export type EventWorkflows = ReturnType<typeof eventWorkflows>;
