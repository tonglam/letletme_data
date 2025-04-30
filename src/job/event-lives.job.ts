import { cron, Patterns } from '@elysiajs/cron';
import { Elysia } from 'elysia';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructure/logger';

import { DecoratedDependencies, eventCache } from '@/dependencies';

const logger = getWorkflowLogger();

export const eventLivesJob = (dependencies: DecoratedDependencies) =>
  new Elysia()
    .use(
      cron({
        name: 'event-lives-cache-match-time',
        pattern: Patterns.everyMinutes(1),
        async run() {
          const jobName = 'event-lives-cache-match-time';
          logger.info(`Running ${jobName} job`);

          await pipe(
            eventCache.getCurrentEvent(),
            TE.chainW((event) =>
              pipe(
                dependencies.eventService.isMatchTime(event.id),
                TE.filterOrElseW(
                  (isMatchTimeResult) => isMatchTimeResult,
                  () => {
                    return TE.right(undefined);
                  },
                ),
                TE.chainW(() => {
                  logger.info(
                    { eventId: event.id, job: jobName },
                    'Proceeding with syncEventLiveCache.',
                  );
                  return dependencies.eventLiveWorkflows.syncEventLiveCache(event.id);
                }),
              ),
            ),
          )();
        },
      }),
    )
    .use(
      cron({
        name: 'event-lives-match-time',
        pattern: Patterns.everyMinutes(30),
        async run() {
          const jobName = 'event-lives-match-time';
          logger.info(`Running ${jobName} job`);

          await pipe(
            eventCache.getCurrentEvent(),
            TE.chainW((event) =>
              pipe(
                dependencies.eventService.isMatchTime(event.id),
                TE.filterOrElseW(
                  (isMatchTimeResult) => isMatchTimeResult,
                  () => {
                    return TE.right(undefined);
                  },
                ),
                TE.chainW(() => {
                  logger.info(
                    { eventId: event.id, job: jobName },
                    'Proceeding with syncEventLives.',
                  );
                  return dependencies.eventLiveWorkflows.syncEventLives(event.id);
                }),
              ),
            ),
          )();
        },
      }),
    )
    .use(
      cron({
        name: 'event-lives-daily',
        pattern: Patterns.everyHours(2),
        async run() {
          logger.info('Running event-lives-daily job');
          await pipe(
            eventCache.getCurrentEvent(),
            TE.match(
              (error) => {
                logger.error(
                  { err: error },
                  'Failed to get current event for event-lives-daily job',
                );
              },
              (event) => {
                dependencies.eventLiveWorkflows.syncEventLives(event.id);
                logger.info(
                  `event-lives-daily job: Triggered syncEventLives for event ${event.id}`,
                );
              },
            ),
          )();
        },
      }),
    )
    .use(
      cron({
        name: 'event-live-explains-daily',
        pattern: Patterns.everyHours(2),
        async run() {
          logger.info('Running event-live-explains-daily job');
          await pipe(
            eventCache.getCurrentEvent(),
            TE.match(
              (error) => {
                logger.error(
                  { err: error },
                  'Failed to get current event for event-live-explains-daily job',
                );
              },
              (event) => {
                dependencies.eventLiveExplainWorkflows.syncEventLiveExplains(event.id);
                logger.info(
                  `event-live-explains-daily job: Triggered syncEventLiveExplains for event ${event.id}`,
                );
              },
            ),
          )();
        },
      }),
    )
    .use(
      cron({
        name: 'event-overall-results-daily',
        pattern: Patterns.everyHours(2),
        async run() {
          logger.info('Running event-overall-results-daily job');
          await pipe(
            eventCache.getCurrentEvent(),
            TE.match(
              (error) => {
                logger.error(
                  { err: error },
                  'Failed to get current event for event-overall-results-daily job',
                );
              },
              (event) => {
                dependencies.eventOverallResultWorkflows.syncEventOverallResults(event.id);
                logger.info(
                  `event-overall-results-daily job: Triggered syncEventOverallResults for event ${event.id}`,
                );
              },
            ),
          )();
        },
      }),
    );
