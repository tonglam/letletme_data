import { DecoratedDependencies } from '@app/dependencies';
import { getWorkflowLogger } from '@app/infrastructure/logging/logger';
import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

const logger = getWorkflowLogger();

export const fixturesJob = (dependencies: DecoratedDependencies) =>
  new Elysia().use(
    cron({
      name: 'fixtures',
      pattern: '38 06 * * *',
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
