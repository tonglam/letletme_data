import dotenv from 'dotenv';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import pino from 'pino';
import { fetchBootstrapEvents } from '../domains/bootstrap/operations';
import { saveBatchEvents } from '../domains/events/operations';
import { eventRepository } from '../domains/events/repository';
import { createFPLClient } from '../infrastructure/api/fpl';
import { META_QUEUE_CONFIG } from '../infrastructure/queue/config/queue.config';
import { createMetaWorkerService } from '../services/queue/meta/base/meta.worker';
import { eventJobService } from '../services/queue/meta/events.job';

dotenv.config();

const logger = pino({ level: 'debug' });

async function main() {
  logger.info('Starting application and worker...');

  // Test database connection first
  try {
    const count = await eventRepository.prisma.event.count();
    logger.info({ count }, 'Current events in database');
  } catch (error) {
    logger.error({ error }, 'Failed to connect to database');
    throw error;
  }

  // Test FPL API connection and database write
  const fplClient = createFPLClient();
  try {
    await pipe(
      fetchBootstrapEvents(fplClient),
      TE.chain((events) => {
        logger.info({ count: events.length }, 'Successfully fetched events from FPL API');

        // Try to save all events directly
        logger.info('Attempting to save all events directly');
        return pipe(
          saveBatchEvents(events),
          TE.map((savedEvents) => {
            logger.info({ count: savedEvents.length }, 'Successfully saved all events directly');
            return savedEvents;
          }),
        );
      }),
      TE.mapLeft((error) => {
        logger.error({ error }, 'Failed to test FPL API or database write');
        throw error;
      }),
    )();
  } catch (error) {
    logger.error({ error }, 'Failed to test FPL API or database write');
    throw error;
  }

  // Initialize and start worker
  const worker = createMetaWorkerService(
    {
      process: (job) => {
        logger.info({ jobId: job.id, data: job.data }, 'Processing job');
        return pipe(
          eventJobService.processEventJob(job),
          TE.map((result) => {
            logger.info({ jobId: job.id }, 'Job processed successfully');
            return result;
          }),
          TE.mapLeft((error) => {
            logger.error({ jobId: job.id, error }, 'Job processing failed');
            throw error;
          }),
        );
      },
      onCompleted: (job) => {
        logger.info({ jobId: job.id }, 'Job completed successfully');
      },
      onFailed: (job, error) => {
        logger.error({ jobId: job.id, error }, 'Job failed');
      },
      onError: (error) => {
        logger.error({ error }, 'Worker error');
      },
    },
    META_QUEUE_CONFIG,
  );

  // Start worker
  await worker.start()();
  logger.info('Worker started successfully');

  // Trigger events sync
  logger.info('Triggering events sync...');
  await eventJobService.scheduleEventsSync()();

  // Keep the process running
  logger.info('Application is running. Press Ctrl+C to stop.');
}

main().catch((error) => {
  logger.error({ error }, 'Application failed to start');
  process.exit(1);
});
