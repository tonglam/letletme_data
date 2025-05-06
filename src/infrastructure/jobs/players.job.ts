import { DecoratedDependencies } from '@app/dependencies';
import { getWorkflowLogger } from '@app/infrastructure/logging/logger';
import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

const logger = getWorkflowLogger();

export const playersJob = (dependencies: DecoratedDependencies) =>
  new Elysia().use(
    cron({
      name: 'players',
      pattern: '36 06 * * *',
      async run() {
        logger.info('Running players job');
        await pipe(
          dependencies.playerWorkflows.syncPlayers(),
          TE.match(
            (error) => {
              logger.error({ err: error }, 'Players job failed');
            },
            () => {
              logger.info('Players job completed successfully');
            },
          ),
        )();
      },
    }),
  );
