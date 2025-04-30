import { cron, Patterns } from '@elysiajs/cron';
import { Elysia } from 'elysia';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { DecoratedDependencies } from '@/dependencies';
import { getWorkflowLogger } from '@/infrastructure/logger';

const logger = getWorkflowLogger();

export const playerValuesJob = (dependencies: DecoratedDependencies) =>
  new Elysia()
    .use(
      cron({
        name: 'player-values',
        pattern: '28-35 9 * * *',
        async run() {
          logger.info('Running player-values job');
          await pipe(
            dependencies.playerValueWorkflows.syncPlayerValues(),
            TE.match(
              (error) => {
                logger.error({ err: error }, 'Player values job failed');
              },
              () => {
                logger.info('Player values job completed successfully');
              },
            ),
          )();
        },
      }),
    )
    .use(
      cron({
        name: 'player-value-tracks',
        pattern: Patterns.everyHours(1),
        async run() {
          logger.info('Running player-value-tracks job');
          await pipe(
            dependencies.playerValueTrackWorkflows.syncPlayerValueTracks(),
            TE.match(
              (error) => {
                logger.error({ err: error }, 'Player value tracks job failed');
              },
              () => {
                logger.info('Player value tracks job completed successfully');
              },
            ),
          )();
        },
      }),
    );
