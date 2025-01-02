// Event Service Workflow Module
// Provides high-level workflow operations combining multiple event service operations.
// Implements orchestration of complex event management tasks.

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { getWorkflowLogger } from '../../infrastructure/logger';
import { ServiceError } from '../../types/errors.type';
import type { Event } from '../../types/events.type';
import type { EventService } from './types';

const logger = getWorkflowLogger();

// Creates event workflow operations
export const eventWorkflows = (eventService: EventService) => {
  // Syncs events from FPL API to local database
  const syncEvents = (): TE.TaskEither<ServiceError, readonly Event[]> =>
    pipe(
      logger.info({ workflow: 'event-sync' }, 'Starting event sync'),
      () =>
        pipe(
          eventService.getEvents(),
          TE.mapLeft((error: ServiceError) => ({
            ...error,
            message: `Failed to fetch events: ${error.message}`,
          })),
        ),
      TE.chain((events: readonly Event[]) => {
        logger.info({ workflow: 'event-sync', count: events.length }, 'Syncing events to database');
        return pipe(
          eventService.saveEvents(events),
          TE.mapLeft((error: ServiceError) => ({
            ...error,
            message: `Failed to save events: ${error.message}`,
          })),
          TE.map((savedEvents: readonly Event[]) => {
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
