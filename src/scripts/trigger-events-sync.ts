import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import pino from 'pino';
import { fetchBootstrapEvents } from '../domains/bootstrap/operations';
import { createFPLClient } from '../infrastructures/http/fpl';
import { eventJobService } from '../queues/meta/events.job';

const logger = pino({ level: 'info' });

const triggerEventsSync = async () => {
  logger.info('Starting events sync process');

  // Test FPL API connection first
  const fplClient = createFPLClient();
  logger.info('Testing FPL API connection...');

  try {
    await pipe(
      fetchBootstrapEvents(fplClient),
      TE.map((events) => {
        logger.info({ count: events.length }, 'Successfully fetched events from FPL API');
        return events;
      }),
      TE.mapLeft((error) => {
        logger.error({ error }, 'Failed to fetch events from FPL API');
        throw error;
      }),
    )();

    // If we got here, API is working, now schedule the job
    logger.info('Scheduling events sync job');
    await pipe(
      eventJobService.scheduleEventsSync(),
      TE.map(() => logger.info('Events sync job scheduled successfully')),
      TE.mapLeft((error) => {
        logger.error({ error }, 'Failed to schedule events sync job');
        throw error;
      }),
    )();
  } catch (error) {
    logger.error({ error }, 'Events sync process failed');
    throw error;
  }
};

triggerEventsSync()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
