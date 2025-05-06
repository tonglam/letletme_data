import { DecoratedDependencies } from '@app/dependencies';
import { getWorkflowLogger } from '@app/infrastructure/logging/logger';
import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

const logger = getWorkflowLogger();

export const eventsJob = (dependencies: DecoratedDependencies) =>
  new Elysia().use(
    cron({
      name: 'events',
      pattern: '30 6 * * *',
      async run() {
        logger.info('Running events job');
        await pipe(
          dependencies.eventWorkflows.syncEvents(),
          TE.match(
            (error) => {
              logger.error({ err: error }, 'Events job failed');
            },
            () => {
              logger.info('Events job completed successfully');
            },
          ),
        )();
      },
    }),
  );
