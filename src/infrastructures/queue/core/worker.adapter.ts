import { Job, Worker, WorkerOptions } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createQueueConfig } from '../../../configs/queue/queue.config';
import { QueueError, QueueErrorCode } from '../../../types/errors.type';
import {
  BaseJobData,
  JobProcessor,
  QueueOperation,
  WorkerAdapter,
  WorkerContext,
  WorkerState,
} from '../../../types/queue.type';
import { createStandardQueueError } from '../../../utils/queue.utils';

const createWorkerConnection = (host: string, port: number): WorkerOptions['connection'] => ({
  host,
  port,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  connectTimeout: 5000,
});

const createWorkerConfig = (prefix: string, isTest: boolean): WorkerOptions => ({
  connection: createWorkerConnection(
    process.env.REDIS_HOST || 'localhost',
    parseInt(process.env.REDIS_PORT || '6379', 10),
  ),
  prefix,
  autorun: false,
  lockDuration: isTest ? 5000 : 30000,
  concurrency: 1,
  maxStalledCount: 1,
  stalledInterval: isTest ? 5000 : 30000,
  drainDelay: 1,
  blockingConnection: false,
  settings: {
    backoffStrategy: () => 1000,
  },
});

const createQueueError = (
  code: QueueErrorCode,
  message: string,
  queueName: string,
  operation: QueueOperation,
  cause: Error,
): QueueError =>
  createStandardQueueError({
    code,
    message,
    queueName,
    operation,
    cause,
  });

const setupWorkerEvents = <T extends BaseJobData>({ worker, state }: WorkerContext<T>): void => {
  const updateState = (newState: Partial<WorkerState>): void => {
    Object.assign(state, newState);
  };

  worker.on('ready', () => {
    console.log('Worker ready');
    updateState({ isRunning: true });
  });

  worker.on('error', (error) => {
    console.error('Worker error:', error);
    updateState({ isRunning: false });
  });

  worker.on('failed', (job, error) => {
    console.error('Worker job failed:', job?.id, error);
    if (job) {
      const queueError = createQueueError(
        QueueErrorCode.PROCESSING_ERROR,
        error instanceof Error ? error.message : String(error),
        worker.name,
        QueueOperation.PROCESS_JOB,
        error instanceof Error ? error : new Error(String(error)),
      );
      job.failedReason = queueError.message;
    }
  });

  worker.on('completed', (job) => {
    console.log('Worker job completed:', job?.id);
  });

  worker.on('stalled', (jobId) => {
    console.warn('Worker job stalled:', jobId);
  });

  worker.on('drained', () => {
    console.log('Worker queue drained');
  });

  worker.on('active', (job) => {
    console.log('Worker job active:', job?.id);
  });

  worker.on('closing', () => {
    console.log('Worker closing');
    updateState({ isClosing: true, isRunning: false });
  });

  worker.on('closed', () => {
    console.log('Worker closed');
    updateState({ isClosing: false, isRunning: false });
  });
};

const createJobProcessor = <T extends BaseJobData>(
  queueName: string,
  processor: JobProcessor<T>,
): ((job: Job<T>) => Promise<void>) => {
  return async (job: Job<T>) => {
    try {
      console.log('Worker processing job:', job.id);
      const result = await processor(job)();
      if (result._tag === 'Left') {
        console.error('Worker job failed with error:', result.left);
        job.failedReason = result.left.message;
        throw result.left;
      }
      console.log('Worker completed job:', job.id);
    } catch (error) {
      console.error('Worker job processing error:', error);
      const queueError = createQueueError(
        QueueErrorCode.PROCESSING_ERROR,
        error instanceof Error ? error.message : String(error),
        queueName,
        QueueOperation.PROCESS_JOB,
        error instanceof Error ? error : new Error(String(error)),
      );
      job.failedReason = queueError.message;
      throw queueError;
    }
  };
};

const handleWorkerStart = <T extends BaseJobData>({
  worker,
  state,
}: WorkerContext<T>): TE.TaskEither<QueueError, void> =>
  pipe(
    TE.tryCatch(
      async () => {
        if (!state.isRunning && !state.isClosing) {
          console.log('Starting worker...');

          await pipe(
            new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => {
                worker.off('ready', onReady);
                worker.off('error', onError);
                reject(new Error('Worker ready timeout'));
              }, 5000);

              const onReady = () => {
                clearTimeout(timeout);
                worker.off('ready', onReady);
                worker.off('error', onError);
                Object.assign(state, { isRunning: true });
                console.log('Worker ready event received');
                resolve();
              };

              const onError = (error: Error) => {
                clearTimeout(timeout);
                worker.off('ready', onReady);
                worker.off('error', onError);
                Object.assign(state, { isRunning: false });
                console.error('Worker start error:', error);
                reject(error);
              };

              worker.once('ready', onReady);
              worker.once('error', onError);
              worker.run().catch(onError);
            }),
          );

          await new Promise((resolve) => setTimeout(resolve, 1000));

          if (!worker.isRunning()) {
            Object.assign(state, { isRunning: false });
            throw new Error('Worker failed to start properly');
          }

          Object.assign(state, { isRunning: true });
          console.log('Worker started successfully');
        } else {
          console.log('Worker already running');
        }
      },
      (error) =>
        createQueueError(
          QueueErrorCode.PROCESSING_ERROR,
          'Failed to start worker',
          worker.name,
          QueueOperation.START_WORKER,
          error as Error,
        ),
    ),
  );

const handleWorkerStop = <T extends BaseJobData>({
  worker,
  state,
}: WorkerContext<T>): TE.TaskEither<QueueError, void> =>
  pipe(
    TE.tryCatch(
      async () => {
        if (worker.isRunning()) {
          console.log('Stopping worker...');
          Object.assign(state, { isClosing: true });
          try {
            await worker.close(true);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            if (worker.isRunning()) {
              throw new Error('Worker failed to stop properly');
            }
            console.log('Worker stopped successfully');
          } catch (error) {
            console.error('Error stopping worker:', error);
            throw error;
          } finally {
            Object.assign(state, { isClosing: false, isRunning: false });
          }
        } else {
          console.log('Worker already stopped');
        }
      },
      (error) =>
        createQueueError(
          QueueErrorCode.PROCESSING_ERROR,
          'Failed to stop worker',
          worker.name,
          QueueOperation.STOP_WORKER,
          error as Error,
        ),
    ),
  );

/**
 * Creates a worker adapter with the given configuration and processor
 */
export const createWorkerAdapter = <T extends BaseJobData>(
  queueName: string,
  processor: JobProcessor<T>,
): TE.TaskEither<QueueError, WorkerAdapter<T>> =>
  pipe(
    TE.tryCatch(
      async () => {
        const config = createQueueConfig(queueName);
        const workerConfig = createWorkerConfig(config.prefix, process.env.NODE_ENV === 'test');
        const worker = new Worker<T>(
          config.name,
          createJobProcessor(queueName, processor),
          workerConfig,
        );

        const state: WorkerState = { isRunning: false, isClosing: false };
        const context: WorkerContext<T> = { worker, state };

        setupWorkerEvents(context);

        return {
          worker,
          start: () => handleWorkerStart(context),
          stop: () => handleWorkerStop(context),
          isRunning: () => {
            const workerRunning = worker.isRunning();
            if (workerRunning && !state.isRunning) {
              Object.assign(state, { isRunning: true });
            } else if (!workerRunning && state.isRunning) {
              Object.assign(state, { isRunning: false });
            }
            return state.isRunning && !state.isClosing;
          },
        };
      },
      (error) =>
        createQueueError(
          QueueErrorCode.CONNECTION_ERROR,
          'Failed to create worker',
          queueName,
          QueueOperation.CREATE_WORKER,
          error as Error,
        ),
    ),
  );
