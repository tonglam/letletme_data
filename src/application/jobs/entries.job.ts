import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructure/logger';

import { DecoratedDependencies } from '../../dependencies';

const logger = getWorkflowLogger();

export const entriesJob = (dependencies: DecoratedDependencies) =>
  new Elysia()
    .use(
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
    )
    .use(
      cron({
        name: 'entry-league-info',
        pattern: '10 10 * * *',
        async run() {
          logger.info('Running entry league info job');
          await pipe(
            dependencies.entryLeagueInfoWorkflows.syncLeagueInfos(),
            TE.match(
              (error) => {
                logger.error({ err: error }, 'Entry league info job failed');
              },
              () => {
                logger.info('Entry league info job completed successfully');
              },
            ),
          )();
        },
      }),
    )
    .use(
      cron({
        name: 'entry-history-info',
        pattern: '20 10 * * *',
        async run() {
          logger.info('Running entry history info job');
          await pipe(
            dependencies.entryHistoryInfoWorkflows.syncHistoryInfos(),
            TE.match(
              (error) => {
                logger.error({ err: error }, 'Entry history info job failed');
              },
              () => {
                logger.info('Entry history info job completed successfully');
              },
            ),
          )();
        },
      }),
    );
