import { Job } from 'bullmq';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { phaseRepository } from '../../../domains/phases/repository';
import { APIError } from '../../../infrastructure/api/common/errors';
import { JobOperation, JobOptions, MetaJobData } from '../../../infrastructure/queue';
import { createQueueProcessingError } from '../../../infrastructure/queue/core/errors';
import { PhaseId } from '../../../types/phases.type';
import { MetaQueueService } from './base/meta.queue';

/**
 * Phase job service
 * Handles phase-specific job processing and scheduling
 */
export class PhaseJobService {
  constructor(
    private readonly metaQueue: MetaQueueService,
    private readonly phaseRepo: typeof phaseRepository,
  ) {}

  /**
   * Process a phase job based on operation type
   */
  processPhaseJob = (job: Job<MetaJobData>): TE.TaskEither<Error, void> => {
    const { operation, id, options } = job.data.data;

    switch (operation) {
      case JobOperation.UPDATE:
        return this.handlePhaseUpdate(id, options);
      case JobOperation.SYNC:
        return this.handlePhaseSync(options);
      case JobOperation.DELETE:
        return this.handlePhaseDelete(id);
      default:
        return TE.left(
          createQueueProcessingError({
            message: `Unknown phase operation: ${operation}`,
            job,
          }),
        );
    }
  };

  /**
   * Schedule a phase update job
   */
  schedulePhaseUpdate = (
    id: number,
    options?: Pick<JobOptions, 'forceUpdate'>,
  ): TE.TaskEither<Error, Job<MetaJobData>> =>
    this.metaQueue.addPhasesJob({
      data: {
        operation: JobOperation.UPDATE,
        id,
        options,
      },
    });

  /**
   * Schedule a phase sync job
   */
  schedulePhasesSync = (options?: JobOptions): TE.TaskEither<Error, Job<MetaJobData>> =>
    this.metaQueue.addPhasesJob({
      data: {
        operation: JobOperation.SYNC,
        options,
      },
    });

  /**
   * Schedule a phase deletion job
   */
  schedulePhaseDelete = (id: number): TE.TaskEither<Error, Job<MetaJobData>> =>
    this.metaQueue.addPhasesJob({
      data: {
        operation: JobOperation.DELETE,
        id,
      },
    });

  /**
   * Handle phase update operation
   */
  private handlePhaseUpdate = (id?: number, options?: JobOptions): TE.TaskEither<Error, void> =>
    pipe(
      TE.fromEither(
        E.fromNullable(
          createQueueProcessingError({ message: 'Phase ID is required for update operation' }),
        )(id),
      ),
      TE.chain((phaseId) =>
        pipe(
          this.phaseRepo.findById(phaseId as unknown as PhaseId),
          TE.mapLeft((e: APIError) => new Error(e.message)),
          TE.chain((phase) =>
            phase
              ? pipe(
                  this.phaseRepo.update(phase.id as unknown as PhaseId, {
                    ...phase,
                    id: phase.id,
                    ...(options?.forceUpdate && { forceUpdate: options.forceUpdate }),
                  }),
                  TE.mapLeft((e: APIError) => new Error(e.message)),
                  TE.map(() => undefined),
                )
              : TE.left(new Error(`Phase not found: ${phaseId}`)),
          ),
        ),
      ),
    );

  /**
   * Handle phase sync operation
   */
  private handlePhaseSync = (options?: JobOptions): TE.TaskEither<Error, void> =>
    pipe(
      options?.targetIds
        ? this.phaseRepo.findByIds(options.targetIds as unknown as PhaseId[])
        : this.phaseRepo.findAll(),
      TE.mapLeft((e: APIError) => new Error(e.message)),
      TE.chain((phases) =>
        pipe(
          phases,
          TE.traverseArray((phase) =>
            pipe(
              this.phaseRepo.update(phase.id as unknown as PhaseId, {
                ...phase,
                id: phase.id,
                ...(options?.forceUpdate && { forceUpdate: options.forceUpdate }),
                ...(options?.validateOnly && { validateOnly: options.validateOnly }),
              }),
              TE.mapLeft((e: APIError) => new Error(e.message)),
            ),
          ),
          TE.map(() => undefined),
        ),
      ),
    );

  /**
   * Handle phase delete operation
   */
  private handlePhaseDelete = (id?: number): TE.TaskEither<Error, void> =>
    pipe(
      TE.fromEither(
        E.fromNullable(
          createQueueProcessingError({ message: 'Phase ID is required for delete operation' }),
        )(id),
      ),
      TE.chain((phaseId) =>
        pipe(
          this.phaseRepo.deleteByIds([phaseId as unknown as PhaseId]),
          TE.mapLeft((e: APIError) => new Error(e.message)),
        ),
      ),
    );
}
