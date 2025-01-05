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
  const syncEvents = (): TE.TaskEither<ServiceError, readonly Event[]> => {
    logger.info({ workflow: 'event-sync' }, 'Starting event sync from API');
    return pipe(
      eventService.syncEventsFromApi(),
      TE.mapLeft((error: ServiceError) => ({
        ...error,
        message: `Failed to sync events from API: ${error.message}`,
      })),
      TE.map((events) => {
        logger.info(
          { workflow: 'event-sync', count: events.length },
          'Successfully synced events from API',
        );
        return events;
      }),
    );
  };

  return {
    syncEvents,
  } as const;
};

export type EventWorkflows = ReturnType<typeof eventWorkflows>;
