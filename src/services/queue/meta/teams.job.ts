import { Job } from 'bullmq';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { teamRepository } from '../../../domains/teams/repository';
import { APIError } from '../../../infrastructure/api/common/errors';
import { createFPLClient } from '../../../infrastructure/api/fpl';
import { JobOperation, JobOptions, MetaJobData } from '../../../infrastructure/queue';
import { createQueueProcessingError } from '../../../infrastructure/queue/core/errors';
import { PrismaTeamCreate, TeamId } from '../../../types/teams.type';
import { createTeamServiceImpl } from '../../teams/service';
import { createMetaQueueService, MetaQueueService } from './base/meta.queue';

/**
 * Team job service
 * Handles team-specific job processing and scheduling
 */
export class TeamJobService {
  private readonly teamService;

  constructor(
    private readonly metaQueue: MetaQueueService,
    private readonly teamRepo: typeof teamRepository,
  ) {
    const bootstrapApi = createFPLClient();
    this.teamService = createTeamServiceImpl({
      bootstrapApi,
      teamRepository,
    });
  }

  /**
   * Process a team job based on operation type
   */
  processTeamsJob = (job: Job<MetaJobData>): TE.TaskEither<Error, void> => {
    const { operation, id, options } = job.data.data;

    switch (operation) {
      case JobOperation.UPDATE:
        return this.handleTeamUpdate(id, options);
      case JobOperation.SYNC:
        return this.handleTeamSync(options);
      case JobOperation.DELETE:
        return this.handleTeamDelete(id);
      default:
        return TE.left(
          createQueueProcessingError({
            message: `Unknown team operation: ${operation}`,
            job,
          }),
        );
    }
  };

  /**
   * Schedule a team update job
   */
  scheduleTeamUpdate = (
    id: number,
    options?: Pick<JobOptions, 'forceUpdate'>,
  ): TE.TaskEither<Error, Job<MetaJobData>> =>
    this.metaQueue.addTeamsJob({
      data: {
        operation: JobOperation.UPDATE,
        id,
        options,
      },
    });

  /**
   * Schedule a team sync job
   */
  scheduleTeamsSync = (options?: JobOptions): TE.TaskEither<Error, Job<MetaJobData>> =>
    this.metaQueue.addTeamsJob({
      data: {
        operation: JobOperation.SYNC,
        options,
      },
    });

  /**
   * Schedule a team deletion job
   */
  scheduleTeamDelete = (id: number): TE.TaskEither<Error, Job<MetaJobData>> =>
    this.metaQueue.addTeamsJob({
      data: {
        operation: JobOperation.DELETE,
        id,
      },
    });

  /**
   * Handle team update operation
   */
  private handleTeamUpdate = (id?: number, options?: JobOptions): TE.TaskEither<Error, void> =>
    pipe(
      TE.fromEither(
        E.fromNullable(
          createQueueProcessingError({ message: 'Team ID is required for update operation' }),
        )(id),
      ),
      TE.chain((teamId) =>
        pipe(
          this.teamRepo.findById(teamId as unknown as TeamId),
          TE.mapLeft((e: APIError) => new Error(e.message)),
          TE.chain((team) =>
            team
              ? pipe(
                  this.teamRepo.update(team.id as unknown as TeamId, {
                    ...team,
                    id: team.id,
                    ...(options?.forceUpdate && { forceUpdate: options.forceUpdate }),
                  } satisfies Partial<PrismaTeamCreate>),
                  TE.mapLeft((e: APIError) => new Error(e.message)),
                  TE.map(() => undefined),
                )
              : TE.left(new Error(`Team not found: ${teamId}`)),
          ),
        ),
      ),
    );

  /**
   * Handle team sync operation
   */
  private handleTeamSync = (options?: JobOptions): TE.TaskEither<Error, void> => {
    if (options?.targetIds) {
      return pipe(
        this.teamRepo.findByIds(options.targetIds as unknown as TeamId[]),
        TE.mapLeft((error) => new Error(`Failed to sync teams: ${error.message}`)),
        TE.map(() => undefined),
      );
    }

    return pipe(
      this.teamService.syncTeams(),
      TE.mapLeft((error) => new Error(`Failed to sync teams: ${error.message}`)),
      TE.map(() => undefined),
    );
  };

  /**
   * Handle team delete operation
   */
  private handleTeamDelete = (id?: number): TE.TaskEither<Error, void> =>
    pipe(
      TE.fromEither(
        E.fromNullable(
          createQueueProcessingError({ message: 'Team ID is required for delete operation' }),
        )(id),
      ),
      TE.chain((teamId) =>
        pipe(
          this.teamRepo.deleteByIds([teamId as unknown as TeamId]),
          TE.mapLeft((e: APIError) => new Error(e.message)),
        ),
      ),
    );
}

// Create and export singleton instance
const metaQueue = createMetaQueueService();
export const teamJobService = new TeamJobService(metaQueue, teamRepository);
