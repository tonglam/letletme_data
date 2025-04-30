import { cron, Patterns } from '@elysiajs/cron';
import { Elysia } from 'elysia';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { DecoratedDependencies } from '@/dependencies';
import { getWorkflowLogger } from '@/infrastructure/logger';

const logger = getWorkflowLogger();

export const fixturesJob = (dependencies: DecoratedDependencies) =>
  new Elysia().use(
    cron({
      name: 'fixtures',
      pattern: Patterns.everyDayAt('06:38'),
      async run() {
        logger.info('Running fixtures job');
        await pipe(
          dependencies.fixtureWorkflows.syncFixtures(),
          TE.match(
            (error) => {
              logger.error({ err: error }, 'Fixtures job failed');
            },
            () => {
              logger.info('Fixtures job completed successfully');
            },
          ),
        )();
      },
    }),
  );
