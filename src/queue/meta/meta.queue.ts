import { Job, Worker } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QUEUE_CONFIG } from '../../config/queue/queue.config';
import { getQueueLogger } from '../../infrastructure/logger';
import { createQueueService } from '../../infrastructure/queue/core/queue.service';
import { JobOptions } from '../../infrastructure/queue/types';
import { createQueueError, QueueError, QueueErrorCode } from '../../types/errors.type';
import {
  MetaJobData,
  MetaOperation,
  MetaQueueService,
  MetaService,
  MetaType,
} from '../../types/job.type';
import { QueueConfig } from '../../types/queue.type';

const logger = getQueueLogger();

// Base meta job data creator
export const createMetaJobData = (operation: MetaOperation, metaType: MetaType): MetaJobData => ({
  type: 'META',
  name: 'meta',
  timestamp: new Date(),
  data: {
    operation,
    metaType,
  },
});

// Base meta job processor type
export type MetaJobProcessor = (
  job: Job<MetaJobData>,
  metaService: MetaService,
) => TE.TaskEither<QueueError, void>;

// Base meta job processor
export const createMetaJobProcessor =
  (processors: Partial<Record<MetaType, MetaJobProcessor>>): MetaJobProcessor =>
  (job: Job<MetaJobData>, metaService: MetaService) =>
    pipe(
      TE.Do,
      TE.chain(() => {
        const { operation, metaType } = job.data.data;
        logger.info({ jobId: job.id, operation, metaType }, 'Processing meta job');

        const processor = processors[metaType];
        if (!processor) {
          return TE.left(
            createQueueError(
              QueueErrorCode.PROCESSING_ERROR,
              'meta',
              new Error(`No processor found for meta type: ${metaType}`),
            ),
          );
        }

        return processor(job, metaService);
      }),
      TE.mapLeft((error) => {
        logger.error({ error }, 'Failed to process meta job');
        if (error instanceof Error) {
          return createQueueError(QueueErrorCode.PROCESSING_ERROR, 'meta', error);
        }
        return error;
      }),
    );

// Base meta queue service creator
export const createMetaQueueService = (
  config: QueueConfig,
  metaService: MetaService,
  processor: MetaJobProcessor,
): TE.TaskEither<QueueError, MetaQueueService> =>
  pipe(
    TE.Do,
    TE.bind('queueService', () =>
      pipe(
        createQueueService<MetaJobData>('meta', config),
        TE.mapLeft((error) => {
          logger.error({ error }, 'Failed to create queue service');
          return error;
        }),
      ),
    ),
    TE.chain(({ queueService }) =>
      TE.tryCatch(
        async () => {
          const worker = new Worker<MetaJobData>(
            'meta',
            async (job) => {
              const result = await processor(job, metaService)();
              if (result._tag === 'Left') {
                logger.error({ jobId: job.id, error: result.left }, 'Job processing failed');
                throw result.left;
              }
            },
            {
              connection: config.connection,
              concurrency: QUEUE_CONFIG.CONCURRENCY,
              limiter: {
                max: QUEUE_CONFIG.RATE_LIMIT.MAX,
                duration: QUEUE_CONFIG.RATE_LIMIT.DURATION,
              },
              stalledInterval: QUEUE_CONFIG.STALLED_CHECK_INTERVAL,
              maxStalledCount: QUEUE_CONFIG.MAX_ATTEMPTS,
              removeOnComplete: {
                count: QUEUE_CONFIG.RETENTION.COUNT,
                age: QUEUE_CONFIG.RETENTION.AGE,
              },
              removeOnFail: {
                count: QUEUE_CONFIG.RETENTION.COUNT,
                age: QUEUE_CONFIG.RETENTION.AGE,
              },
              settings: {
                backoffStrategy: (attemptsMade: number) => {
                  // Exponential backoff with max limit
                  return Math.min(
                    QUEUE_CONFIG.INITIAL_BACKOFF * Math.pow(2, attemptsMade),
                    QUEUE_CONFIG.MAX_BACKOFF,
                  );
                },
              },
            },
          );

          worker.on('error', (error) => {
            logger.error({ error }, 'Worker error');
          });

          worker.on('failed', (job, error) => {
            if (job) {
              logger.error(
                { jobId: job.id, error, attemptsMade: job.attemptsMade },
                `Job failed, attempts made: ${job.attemptsMade}`,
              );
            } else {
              logger.error({ error }, 'Job failed without job data');
            }
          });

          worker.on('stalled', (jobId) => {
            logger.warn({ jobId }, 'Job stalled');
          });

          // Wait for the worker to be ready
          await new Promise<void>((resolve) => {
            worker.once('ready', () => {
              logger.info('Worker is ready');
              resolve();
            });
          });

          const close = async () => {
            logger.info('Closing worker and queue');
            await worker.close();
            await queueService.getQueue().close();
            logger.info('Worker and queue closed');
          };

          const pause = (isImmediate = false): TE.TaskEither<QueueError, void> =>
            TE.tryCatch(
              async () => {
                logger.info({ isImmediate }, 'Pausing worker');
                await worker.pause(isImmediate);
                logger.info('Worker paused');
              },
              (error) => createQueueError(QueueErrorCode.PAUSE_QUEUE, 'meta', error as Error),
            );

          const resume = (): TE.TaskEither<QueueError, void> =>
            TE.tryCatch(
              async () => {
                logger.info('Resuming worker');
                await worker.resume();
                logger.info('Worker resumed');
              },
              (error) => createQueueError(QueueErrorCode.RESUME_QUEUE, 'meta', error as Error),
            );

          return {
            ...queueService,
            processJob: (job: Job<MetaJobData>) => processor(job, metaService),
            syncMeta: (metaType: MetaType) =>
              pipe(
                createMetaJobData('SYNC', metaType),
                (jobData) =>
                  queueService.addJob(jobData, {
                    attempts: QUEUE_CONFIG.MAX_ATTEMPTS,
                    backoff: {
                      type: 'exponential',
                      delay: QUEUE_CONFIG.INITIAL_BACKOFF,
                    },
                    timeout: QUEUE_CONFIG.JOB_TIMEOUT,
                  } as JobOptions),
                TE.chain(() => metaService.syncMeta(metaType)),
              ),
            worker,
            close,
            pause,
            resume,
          };
        },
        (error) => {
          logger.error({ error }, 'Failed to create worker');
          return createQueueError(QueueErrorCode.CREATE_WORKER, 'meta', error as Error);
        },
      ),
    ),
  );
