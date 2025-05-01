import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructure/logger';

import { DecoratedDependencies } from '../dependencies';

const logger = getWorkflowLogger();

export const entriesJob = (dependencies: DecoratedDependencies) =>
  new Elysia().use(
    cron({
      name: 'entries',
      pattern: '0 10 * * *',
      async run() {
        logger.info('Running entries job');
        await pipe(
          dependencies.entryInfoWorkflows.syncEntryInfos(),
          TE.match(
            (error) => {
              logger.error({ err: error }, 'Entries job failed');
            },
            () => {
              logger.info('Entries job completed successfully');
            },
          ),
        )();
      },
    }),
  );
