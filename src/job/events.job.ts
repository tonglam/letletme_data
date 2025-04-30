import { cron, Patterns } from '@elysiajs/cron';
import { Elysia } from 'elysia';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { DecoratedDependencies } from '@/dependencies';
import { getWorkflowLogger } from '@/infrastructure/logger';

const logger = getWorkflowLogger();

export const eventsJob = (dependencies: DecoratedDependencies) =>
  new Elysia().use(
    cron({
      name: 'events',
      pattern: Patterns.everyDayAt('06:30'),
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
