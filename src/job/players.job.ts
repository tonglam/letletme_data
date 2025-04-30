import { cron, Patterns } from '@elysiajs/cron';
import { Elysia } from 'elysia';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { DecoratedDependencies } from '@/dependencies';
import { getWorkflowLogger } from '@/infrastructure/logger';

const logger = getWorkflowLogger();

export const playersJob = (dependencies: DecoratedDependencies) =>
  new Elysia().use(
    cron({
      name: 'players',
      pattern: Patterns.everyDayAt('06:36'),
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
