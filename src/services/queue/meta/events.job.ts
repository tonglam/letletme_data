import { Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { eventRepository } from '../../../domains/events/repository';
import { createFPLClient } from '../../../infrastructure/http/fpl';
import { JobOperation, JobOptions, MetaJobData } from '../../../infrastructure/queue';
import { createQueueProcessingError } from '../../../infrastructure/queue/core/errors';
import { EventId, PrismaEventUpdate } from '../../../types/domain/events.type';
import { APIError } from '../../../types/errors.type';
import { createEventServiceImpl } from '../../events/service';
import { createMetaQueueService, MetaQueueService } from './base/meta.queue';

export class EventJobService {
  private readonly eventService;

  constructor(
    private readonly metaQueue: MetaQueueService,
    private readonly eventRepo: typeof eventRepository,
  ) {
    const bootstrapApi = createFPLClient();
    this.eventService = createEventServiceImpl({
      bootstrapApi,
      eventRepository,
      eventCache: {
        warmUp: () => TE.right(undefined),
        getAllEvents: () => TE.right([]),
        getEvent: () => TE.right(null),
        getCurrentEvent: () => TE.right(null),
        getNextEvent: () => TE.right(null),
        cacheEvent: () => TE.right(undefined),
        cacheEvents: () => TE.right(undefined),
      },
    });
  }

  /**
   * Process an event job based on operation type
   */
  processEventsJob = (job: Job<MetaJobData>): TE.TaskEither<Error, void> => {
    const { operation, id, options } = job.data.data;

    switch (operation) {
      case JobOperation.UPDATE:
        return this.handleEventUpdate(id, options);
      case JobOperation.SYNC:
        return this.handleEventSync();
      case JobOperation.DELETE:
        return this.handleEventDelete(id);
      default:
        return TE.left(
          createQueueProcessingError({
            message: `Unknown event operation: ${operation}`,
            job,
          }),
        );
    }
  };

  /**
   * Schedule an event update job
   */
  scheduleEventUpdate = (
    id: number,
    options?: Pick<JobOptions, 'forceUpdate'>,
  ): TE.TaskEither<Error, Job<MetaJobData>> =>
    this.metaQueue.addEventsJob({
      data: {
        operation: JobOperation.UPDATE,
        id,
        options,
      },
    });

  /**
   * Schedule an event sync job
   */
  scheduleEventsSync = (options?: JobOptions): TE.TaskEither<Error, Job<MetaJobData>> =>
    this.metaQueue.addEventsJob({
      data: {
        operation: JobOperation.SYNC,
        options,
      },
    });

  /**
   * Schedule an event deletion job
   */
  scheduleEventDelete = (id: number): TE.TaskEither<Error, Job<MetaJobData>> =>
    this.metaQueue.addEventsJob({
      data: {
        operation: JobOperation.DELETE,
        id,
      },
    });

  /**
   * Handle event update operation
   */
  private handleEventUpdate = (id?: number, options?: JobOptions): TE.TaskEither<Error, void> =>
    pipe(
      TE.fromEither(
        E.fromNullable(
          createQueueProcessingError({ message: 'Event ID is required for update operation' }),
        )(id),
      ),
      TE.chain((eventId) =>
        pipe(
          this.eventRepo.findById(eventId as unknown as EventId),
          TE.mapLeft((e: APIError) => new Error(e.message)),
          TE.chain((event) =>
            event
              ? pipe(
                  this.eventRepo.update(event.id as unknown as EventId, {
                    name: event.name,
                    deadlineTime: event.deadlineTime,
                    deadlineTimeEpoch: event.deadlineTimeEpoch,
                    deadlineTimeGameOffset: event.deadlineTimeGameOffset,
                    releaseTime: event.releaseTime,
                    averageEntryScore: event.averageEntryScore,
                    finished: event.finished,
                    dataChecked: event.dataChecked,
                    highestScore: event.highestScore,
                    highestScoringEntry: event.highestScoringEntry,
                    isPrevious: event.isPrevious,
                    isCurrent: event.isCurrent,
                    isNext: event.isNext,
                    cupLeaguesCreated: event.cupLeaguesCreated,
                    h2hKoMatchesCreated: event.h2hKoMatchesCreated,
                    rankedCount: event.rankedCount,
                    chipPlays: event.chipPlays as Prisma.JsonValue,
                    mostSelected: event.mostSelected,
                    mostTransferredIn: event.mostTransferredIn,
                    mostCaptained: event.mostCaptained,
                    mostViceCaptained: event.mostViceCaptained,
                    topElement: event.topElement,
                    topElementInfo: event.topElementInfo as Prisma.JsonValue,
                    transfersMade: event.transfersMade,
                    createdAt: event.createdAt,
                    ...(options?.forceUpdate && { forceUpdate: options.forceUpdate }),
                  } satisfies PrismaEventUpdate),
                  TE.mapLeft((e: APIError) => new Error(e.message)),
                  TE.map(() => undefined),
                )
              : TE.left(new Error(`Event not found: ${eventId}`)),
          ),
        ),
      ),
    );

  /**
   * Handle event sync operation
   */
  private handleEventSync = (): TE.TaskEither<Error, void> =>
    pipe(
      this.eventService.getEvents(),
      TE.mapLeft((error: APIError) => new Error(`Failed to sync events: ${error.message}`)),
      TE.map(() => undefined),
    );

  /**
   * Handle event delete operation
   */
  private handleEventDelete = (id?: number): TE.TaskEither<Error, void> =>
    pipe(
      TE.fromEither(
        E.fromNullable(
          createQueueProcessingError({ message: 'Event ID is required for delete operation' }),
        )(id),
      ),
      TE.chain((eventId) =>
        pipe(
          this.eventRepo.deleteByIds([eventId as unknown as EventId]),
          TE.mapLeft((e: APIError) => new Error(e.message)),
        ),
      ),
    );
}

// Create and export singleton instance
const metaQueue = createMetaQueueService();
export const eventJobService = new EventJobService(metaQueue, eventRepository);
