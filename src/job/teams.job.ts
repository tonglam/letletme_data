import { cron, Patterns } from '@elysiajs/cron';
import { Elysia } from 'elysia';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { DecoratedDependencies } from '@/dependencies';
import { getWorkflowLogger } from '@/infrastructure/logger';

const logger = getWorkflowLogger();

export const teamsJob = (dependencies: DecoratedDependencies) =>
  new Elysia().use(
    cron({
      name: 'teams',
      pattern: Patterns.everyDayAt('06:34'),
      async run() {
        logger.info('Running teams job');
        await pipe(
          dependencies.teamWorkflows.syncTeams(),
          TE.match(
            (error) => {
              logger.error({ err: error }, 'Teams job failed');
            },
            () => {
              logger.info('Teams job completed successfully');
            },
          ),
        )();
      },
    }),
  );
