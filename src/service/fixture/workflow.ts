import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as RA from 'fp-ts/ReadonlyArray';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructure/logger';
import { FixtureWorkflowsOperations } from 'service/fixture/types';
import { FixtureService } from 'service/fixture/types';
import { createWorkflowContext, WorkflowResult } from 'service/types';
import { EventId } from 'types/domain/event.type';
import { createServiceError, ServiceError, ServiceErrorCode } from 'types/error.type';

const logger = getWorkflowLogger();

export const createFixtureWorkflows = (
  fixtureService: FixtureService,
): FixtureWorkflowsOperations => {
  const syncFixtures = (): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext('all-events-fixture-sync');
    const startTime = new Date().getTime();

    logger.info(
      { workflow: context.workflowId },
      'Starting full fixture sync workflow for events 1-38',
    );

    const eventIds = pipe(
      Array.from({ length: 38 }, (_, i) => i + 1),
      RA.fromArray,
      RA.map((n) => n as EventId),
    );

    const tasks: ReadonlyArray<TE.TaskEither<{ eventId: EventId; error: ServiceError }, EventId>> =
      pipe(
        eventIds,
        RA.map((eventId) =>
          pipe(
            fixtureService.syncEventFixturesFromApi(eventId),
            TE.map(() => eventId),
            TE.mapLeft((error) => ({ eventId, error })),
          ),
        ),
      );

    const sequencedResultsTask: T.Task<
      ReadonlyArray<E.Either<{ eventId: EventId; error: ServiceError }, EventId>>
    > = T.sequenceArray(tasks);

    const finalProcessingTask: T.Task<E.Either<ServiceError, WorkflowResult>> = pipe(
      sequencedResultsTask,
      T.map((results) =>
        pipe(results, RA.separate, ({ left: errors, right: successes }) => {
          const duration = new Date().getTime() - startTime;

          logger.info(
            {
              workflow: context.workflowId,
              successfulEventIds: successes,
              failedEventIds: errors.map((e) => e.eventId),
              duration,
            },
            `Fixture sync workflow finished processing ${eventIds.length} events.`,
          );

          if (RA.isNonEmpty(errors)) {
            errors.forEach((err) =>
              logger.error(
                {
                  workflow: context.workflowId,
                  eventId: err.eventId,
                  error: err.error.message,
                  cause: err.error.cause,
                },
                'Event sync failed',
              ),
            );

            return E.left(
              createServiceError({
                code: ServiceErrorCode.INTEGRATION_ERROR,
                message: `Fixture sync workflow completed with ${errors.length} failures out of ${eventIds.length} attempted events. See cause for details.`,
                cause: new Error(JSON.stringify(errors, null, 2)),
              }),
            );
          } else {
            logger.info(
              { workflow: context.workflowId, duration },
              'Full fixture sync workflow completed successfully for all events.',
            );

            return E.right({ context, duration });
          }
        }),
      ),
    );

    const resultTaskEither: TE.TaskEither<ServiceError, WorkflowResult> = finalProcessingTask;

    return resultTaskEither;
  };

  return {
    syncFixtures,
  };
};
