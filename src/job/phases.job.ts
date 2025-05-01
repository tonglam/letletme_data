import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructure/logger';

import { DecoratedDependencies } from '../dependencies';

const logger = getWorkflowLogger();

export const phasesJob = (dependencies: DecoratedDependencies) =>
  new Elysia().use(
    cron({
      name: 'phases',
      pattern: '32 06 * * *',
      async run() {
        logger.info('Running phases job');
        await pipe(
          dependencies.phaseWorkflows.syncPhases(),
          TE.match(
            (error) => {
              logger.error({ err: error }, 'Phases job failed');
            },
            () => {
              logger.info('Phases job completed successfully');
            },
          ),
        )();
      },
    }),
  );
