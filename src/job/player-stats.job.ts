import { cron, Patterns } from '@elysiajs/cron';
import { Elysia } from 'elysia';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { DecoratedDependencies } from '@/dependencies';
import { getWorkflowLogger } from '@/infrastructure/logger';

const logger = getWorkflowLogger();

export const playerStatsJob = (dependencies: DecoratedDependencies) =>
  new Elysia().use(
    cron({
      name: 'player-stats',
      pattern: Patterns.everyDayAt('09:40'),
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
