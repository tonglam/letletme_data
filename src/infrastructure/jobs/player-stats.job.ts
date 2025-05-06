import { DecoratedDependencies } from '@app/dependencies';
import { getWorkflowLogger } from '@app/infrastructure/logging/logger';
import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

const logger = getWorkflowLogger();

export const playerStatsJob = (dependencies: DecoratedDependencies) =>
  new Elysia().use(
    cron({
      name: 'player-stats',
      pattern: '40 09 * * *',
      async run() {
        logger.info('Running player-stats job');
        await pipe(
          dependencies.playerStatWorkflows.syncPlayerStats(),
          TE.match(
            (error) => {
              logger.error({ err: error }, 'Player stats job failed');
            },
            () => {
              logger.info('Player stats job completed successfully');
            },
          ),
        )();
      },
    }),
  );
