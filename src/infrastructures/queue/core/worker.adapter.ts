import { Job, Worker, WorkerOptions } from 'bullmq';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { QueueError, QueueErrorCode } from '../../../types/errors.type';
import {
  BaseJobData,
  JobProcessor,
  WorkerAdapter,
  WorkerContext,
  WorkerStateData,
} from '../../../types/queue.type';
import { QueueOperation } from '../../../types/shared.type';
import { createStandardQueueError } from '../../../utils/queue.utils';

const waitWithTimeout = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const createWorkerConfig = (prefix: string, isTest: boolean): WorkerOptions => ({
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectTimeout: isTest ? 5000 : 10000,
    retryStrategy: (times: number) => {
      console.debug(`[Worker Connection] Retry attempt ${times}`);
      return Math.min(times * 1000, 3000);
    },
  },
  prefix,
  autorun: false,
  lockDuration: isTest ? 10000 : 30000,
  concurrency: 1,
  maxStalledCount: 1,
  stalledInterval: isTest ? 5000 : 30000,
  drainDelay: 1,
  blockingConnection: false,
  settings: {
    backoffStrategy: (attemptsMade: number) => Math.min(1000 * Math.pow(2, attemptsMade), 30000),
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

// Add state management utilities
const WorkerStateManager = {
  STATES: {
    INITIAL: 'INITIAL',
    STARTING: 'STARTING',
    RUNNING: 'RUNNING',
    STOPPING: 'STOPPING',
    STOPPED: 'STOPPED',
    ERROR: 'ERROR',
  },

  create: (): WorkerStateData => ({
    currentState: WorkerStateManager.STATES.INITIAL,
    isRunning: false,
    isClosing: false,
    lastError: null,
    lastStateChange: new Date(),
    stateHistory: [],
  }),

  transition: (state: WorkerStateData, newState: string, error?: Error): void => {
    const oldState = state.currentState;

    // Don't transition if we're already in the target state
    if (oldState === newState) {
      console.debug(`[Worker State] Already in state ${newState}, skipping transition`);
      return;
    }

    // Special handling for ERROR state - always allow transition to ERROR
    if (newState === WorkerStateManager.STATES.ERROR) {
      console.debug('[Worker State] Forcing transition to ERROR state due to error:', error);
      const timestamp = new Date();
      state.currentState = newState;
      state.lastStateChange = timestamp;
      state.lastError = error || null;
      state.isRunning = false;
      state.isClosing = false;
      state.stateHistory.push({
        from: oldState,
        to: newState,
        timestamp,
        error: error?.message,
      });
      return;
    }

    // Special handling for STOPPED state - allow transition from ERROR to STOPPED
    if (
      newState === WorkerStateManager.STATES.STOPPED &&
      oldState === WorkerStateManager.STATES.ERROR
    ) {
      console.debug('[Worker State] Allowing transition from ERROR to STOPPED state');
      const timestamp = new Date();
      state.currentState = newState;
      state.lastStateChange = timestamp;
      state.isRunning = false;
      state.isClosing = false;
      state.stateHistory.push({
        from: oldState,
        to: newState,
        timestamp,
      });
      return;
    }

    // Validate normal transitions
    if (!WorkerStateManager.isTransitionAllowed(state, newState)) {
      console.warn(
        `[Worker State] Invalid transition attempted: ${oldState} -> ${newState}`,
        '\nCurrent state:',
        state,
      );
      return;
    }

    const timestamp = new Date();

    // Update state
    state.currentState = newState;
    state.lastStateChange = timestamp;
    state.lastError = error || null;

    // Update running and closing flags based on state
    state.isRunning = newState === WorkerStateManager.STATES.RUNNING;
    state.isClosing = newState === WorkerStateManager.STATES.STOPPING;

    // Add to history
    state.stateHistory.push({
      from: oldState,
      to: newState,
      timestamp,
      error: error?.message,
    });

    // Debug log
    console.debug(
      `[Worker State] ${oldState} -> ${newState}${error ? ` (Error: ${error.message})` : ''}`,
    );
    if (state.stateHistory.length > 0) {
      console.debug(
        '[Worker State History]',
        JSON.stringify(state.stateHistory.slice(-5), null, 2),
      );
    }
  },

  isTransitionAllowed: (state: WorkerStateData, newState: string): boolean => {
    const current = state.currentState;

    // Allow transition to same state (no-op)
    if (current === newState) {
      return true;
    }

    const STATES = WorkerStateManager.STATES;

    // Define valid transitions
    const validTransitions = {
      [STATES.INITIAL]: [STATES.STARTING, STATES.ERROR],
      [STATES.STARTING]: [STATES.RUNNING, STATES.ERROR, STATES.STOPPING],
      [STATES.RUNNING]: [STATES.STOPPING, STATES.ERROR],
      [STATES.STOPPING]: [STATES.STOPPED, STATES.ERROR],
      [STATES.STOPPED]: [STATES.INITIAL, STATES.ERROR],
      [STATES.ERROR]: [STATES.INITIAL, STATES.STOPPED],
    };

    const isAllowed = validTransitions[current]?.includes(newState);
    if (!isAllowed) {
      console.warn(
        `[Worker State] Invalid transition attempted: ${current} -> ${newState}`,
        '\nCurrent state:',
        state,
      );
    }
    return !!isAllowed;
  },
};

const setupWorkerEvents = <T extends BaseJobData>({ worker, state }: WorkerContext<T>): void => {
  const { STATES } = WorkerStateManager;

  // Track whether we've received the ready event
  let hasReceivedReady = false;

  worker.on('ready', () => {
    console.debug('[Worker Event] Ready event received', {
      currentState: state.currentState,
      isRunning: worker.isRunning(),
      hasReceivedReady,
    });

    // Only handle the first ready event
    if (hasReceivedReady) {
      console.debug('[Worker Event] Ignoring duplicate ready event');
      return;
    }
    hasReceivedReady = true;

    // Only transition to RUNNING if we're in STARTING state
    if (state.currentState === STATES.STARTING) {
      if (WorkerStateManager.isTransitionAllowed(state, STATES.RUNNING)) {
        WorkerStateManager.transition(state, STATES.RUNNING);
      } else {
        console.warn('[Worker Event] Cannot transition to RUNNING state from:', state.currentState);
      }
    } else {
      console.debug(
        '[Worker Event] Ready event ignored - worker not in STARTING state:',
        state.currentState,
      );
    }
  });

  worker.on('error', (error) => {
    console.debug('[Worker Event] Error event received:', {
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
            }
          : error,
      state: state.currentState,
      isRunning: worker.isRunning(),
    });

    // Reset ready event flag on error
    hasReceivedReady = false;

    // Always allow transition to ERROR state
    if (WorkerStateManager.isTransitionAllowed(state, STATES.ERROR)) {
      WorkerStateManager.transition(state, STATES.ERROR, error);
    }
  });

  worker.on('failed', (job, error) => {
    console.error('Worker job failed:', job?.id, error);
    if (job) {
      if (error instanceof Error) {
        job.failedReason = error.message;
      } else if (error && typeof error === 'object' && 'message' in error) {
        const errorObj = error as { message: unknown };
        job.failedReason = String(errorObj.message);
      } else {
        job.failedReason = String(error);
      }
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
    console.debug('[Worker Event] Closing event received', {
      currentState: state.currentState,
      isRunning: worker.isRunning(),
    });

    // Reset ready event flag on closing
    hasReceivedReady = false;

    // Only transition to STOPPING if we're in a valid state
    if (state.currentState !== STATES.ERROR && state.currentState !== STATES.STOPPED) {
      if (WorkerStateManager.isTransitionAllowed(state, STATES.STOPPING)) {
        WorkerStateManager.transition(state, STATES.STOPPING);
      } else {
        console.warn(
          '[Worker Event] Cannot transition to STOPPING state from:',
          state.currentState,
        );
      }
    } else {
      console.debug(
        '[Worker Event] Closing event ignored - worker in invalid state:',
        state.currentState,
      );
    }
  });

  worker.on('closed', () => {
    console.debug('[Worker Event] Closed event received', {
      currentState: state.currentState,
      isRunning: worker.isRunning(),
    });

    // Reset ready event flag on closed
    hasReceivedReady = false;

    // Allow transition to STOPPED from any state except INITIAL
    if (state.currentState !== STATES.INITIAL) {
      if (WorkerStateManager.isTransitionAllowed(state, STATES.STOPPED)) {
        WorkerStateManager.transition(state, STATES.STOPPED);
      } else {
        console.warn('[Worker Event] Cannot transition to STOPPED state from:', state.currentState);
      }
    } else {
      console.debug(
        '[Worker Event] Closed event ignored - worker in invalid state:',
        state.currentState,
      );
    }
  });
};

const handleJobError = <T extends BaseJobData>(job: Job<T>, error: unknown): QueueError => {
  console.error('Worker job failed with error:', error);
  let errorMessage: string;

  if (error instanceof Error) {
    errorMessage = error.message;
  } else if (typeof error === 'object' && error !== null && 'message' in error) {
    const errorObj = error as { message: unknown };
    errorMessage = String(errorObj.message);
  } else if (typeof error === 'string') {
    errorMessage = error;
  } else {
    errorMessage = 'Unknown error';
  }

  job.failedReason = errorMessage;

  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === QueueErrorCode.PROCESSING_ERROR
  ) {
    return error as QueueError;
  }

  const queueError = createStandardQueueError({
    code: QueueErrorCode.PROCESSING_ERROR,
    message: errorMessage,
    queueName: job.queueQualifiedName,
    operation: QueueOperation.PROCESS_JOB,
    cause: error instanceof Error ? error : new Error(String(error)),
  });

  job.failedReason = queueError.message;
  return queueError;
};

const createJobProcessor =
  <T extends BaseJobData>(
    queueName: string,
    processor: JobProcessor<T>,
  ): ((job: Job<T>) => Promise<void>) =>
  async (job: Job<T>) => {
    try {
      console.log('Worker processing job:', job.id);
      const result = await processor(job)();
      if (E.isLeft(result)) {
        const error = result.left;
        if (
          error instanceof Error ||
          (typeof error === 'object' && error !== null && 'message' in error)
        ) {
          job.failedReason = error.message;
          throw error;
        } else {
          const queueError = handleJobError(job, error);
          throw queueError;
        }
      }
      console.log('Worker completed job:', job.id);
    } catch (error: unknown) {
      console.error('Worker job processing error:', error);
      const queueError = handleJobError(job, error);
      throw queueError;
    }
  };

const handleWorkerStart = <T extends BaseJobData>({
  worker,
  state,
}: WorkerContext<T>): TE.TaskEither<QueueError, void> =>
  pipe(
    TE.tryCatch(
      async () => {
        console.debug('[Worker Start] Attempting to start worker', {
          currentState: state.currentState,
          isRunning: worker.isRunning(),
          stateHistory: state.stateHistory,
        });

        // If worker is already running, just return
        if (worker.isRunning() && state.isRunning) {
          console.debug('[Worker Start] Worker already running');
          return;
        }

        // Reset state if in error or stopped state
        if (
          state.currentState === WorkerStateManager.STATES.ERROR ||
          state.currentState === WorkerStateManager.STATES.STOPPED
        ) {
          console.debug('[Worker Start] Resetting worker state', {
            lastError: state.lastError,
            stateHistory: state.stateHistory,
          });
          WorkerStateManager.transition(state, WorkerStateManager.STATES.INITIAL);
          await waitWithTimeout(1000); // Wait for state to settle
        }

        // Ensure we're in INITIAL state before starting
        if (state.currentState !== WorkerStateManager.STATES.INITIAL) {
          console.debug('[Worker Start] Cannot start worker in current state:', {
            currentState: state.currentState,
            stateHistory: state.stateHistory,
          });
          throw new Error(`Cannot start worker in state: ${state.currentState}`);
        }

        // Transition to STARTING state
        WorkerStateManager.transition(state, WorkerStateManager.STATES.STARTING);

        // Start the worker and wait for it to be running
        await new Promise<void>((resolve, reject) => {
          let isResolved = false;
          const maxAttempts = 30; // Try for 30 seconds
          let attempts = 0;

          const cleanup = () => {
            if (!isResolved) {
              isResolved = true;
              worker.off('error', onError);
              clearInterval(checkInterval);
            }
          };

          const onError = (error: Error) => {
            console.debug('[Worker Start] Error event handler triggered:', {
              error:
                error instanceof Error
                  ? {
                      name: error.name,
                      message: error.message,
                      stack: error.stack,
                    }
                  : error,
              state: state.currentState,
            });
            cleanup();
            reject(error);
          };

          worker.once('error', onError);

          // Start the worker
          console.debug('[Worker Start] Running worker');
          worker.run().catch((error) => {
            if (!isResolved) {
              console.debug('[Worker Start] Worker run failed:', {
                error:
                  error instanceof Error
                    ? {
                        name: error.name,
                        message: error.message,
                        stack: error.stack,
                      }
                    : error,
                state: state.currentState,
              });
              onError(error);
            }
          });

          // Check worker state periodically
          const checkInterval = setInterval(async () => {
            attempts++;
            console.debug('[Worker Start] Checking worker state', {
              attempt: attempts,
              isRunning: worker.isRunning(),
              currentState: state.currentState,
            });

            if (worker.isRunning()) {
              console.debug('[Worker Start] Worker is running');
              cleanup();
              WorkerStateManager.transition(state, WorkerStateManager.STATES.RUNNING);
              resolve();
              return;
            }

            if (attempts >= maxAttempts) {
              console.debug('[Worker Start] Worker failed to start after max attempts');
              cleanup();
              reject(new Error('Worker failed to start after max attempts'));
              return;
            }
          }, 1000);
        });

        // Final verification of worker state
        if (!worker.isRunning()) {
          console.debug('[Worker Start] Worker not running after start', {
            currentState: state.currentState,
            stateHistory: state.stateHistory,
          });
          throw new Error('Worker failed to start properly');
        }

        if (!state.isRunning) {
          console.debug('[Worker Start] Worker state not running after start', {
            currentState: state.currentState,
            stateHistory: state.stateHistory,
          });
          throw new Error('Worker state not synchronized');
        }

        console.debug('[Worker Start] Worker started successfully');
      },
      (error) => {
        console.debug('[Worker Start] Error starting worker:', {
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                }
              : error,
          state: state.currentState,
          stateHistory: state.stateHistory,
        });
        if (WorkerStateManager.isTransitionAllowed(state, WorkerStateManager.STATES.ERROR)) {
          WorkerStateManager.transition(state, WorkerStateManager.STATES.ERROR, error as Error);
        }
        return createStandardQueueError({
          code: QueueErrorCode.PROCESSING_ERROR,
          message: error instanceof Error ? error.message : String(error),
          queueName: worker.name,
          operation: QueueOperation.START_WORKER,
          cause: error instanceof Error ? error : new Error(String(error)),
        });
      },
    ),
  );

const handleWorkerStop = <T extends BaseJobData>({
  worker,
  state,
}: WorkerContext<T>): TE.TaskEither<QueueError, void> =>
  pipe(
    TE.tryCatch(
      async () => {
        console.debug('[Worker Stop] Attempting to stop worker');

        if (!worker.isRunning()) {
          console.debug('[Worker Stop] Worker already stopped');
          if (state.currentState !== WorkerStateManager.STATES.STOPPED) {
            WorkerStateManager.transition(state, WorkerStateManager.STATES.STOPPED);
          }
          return;
        }

        console.debug('[Worker Stop] Stopping worker...');
        WorkerStateManager.transition(state, WorkerStateManager.STATES.STOPPING);

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Worker stop timeout'));
          }, 30000);

          worker.once('closed', () => {
            clearTimeout(timeout);
            WorkerStateManager.transition(state, WorkerStateManager.STATES.STOPPED);
            resolve();
          });

          worker.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });

          worker.close(true).catch(reject);
        });

        await waitWithTimeout(1000);
        console.debug('[Worker Stop] Worker stopped successfully');
      },
      (error) => {
        console.debug('[Worker Stop] Error stopping worker:', error);
        if (WorkerStateManager.isTransitionAllowed(state, WorkerStateManager.STATES.ERROR)) {
          WorkerStateManager.transition(state, WorkerStateManager.STATES.ERROR, error as Error);
        }
        return createStandardQueueError({
          code: QueueErrorCode.PROCESSING_ERROR,
          message: error instanceof Error ? error.message : String(error),
          queueName: worker.name,
          operation: QueueOperation.STOP_WORKER,
          cause: error instanceof Error ? error : new Error(String(error)),
        });
      },
    ),
  );

const handleWorkerReset = <T extends BaseJobData>({
  worker,
  state,
}: WorkerContext<T>): TE.TaskEither<QueueError, void> =>
  pipe(
    TE.tryCatch(
      async () => {
        console.debug('[Worker Reset] Attempting to reset worker');

        // If worker is running, stop it first
        if (worker.isRunning()) {
          console.debug('[Worker Reset] Stopping running worker');
          await handleWorkerStop({ worker, state })();
          await waitWithTimeout(1000);
        }

        // Reset state to INITIAL
        console.debug('[Worker Reset] Resetting worker state');
        WorkerStateManager.transition(state, WorkerStateManager.STATES.INITIAL);

        // Start worker again
        console.debug('[Worker Reset] Starting worker');
        await handleWorkerStart({ worker, state })();

        console.debug('[Worker Reset] Worker reset successfully');
      },
      (error) => {
        console.debug('[Worker Reset] Error resetting worker:', {
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                }
              : error,
          state: state.currentState,
          stateHistory: state.stateHistory,
        });
        if (WorkerStateManager.isTransitionAllowed(state, WorkerStateManager.STATES.ERROR)) {
          WorkerStateManager.transition(state, WorkerStateManager.STATES.ERROR, error as Error);
        }
        return createStandardQueueError({
          code: QueueErrorCode.PROCESSING_ERROR,
          message: error instanceof Error ? error.message : String(error),
          queueName: worker.name,
          operation: QueueOperation.RESET_WORKER,
          cause: error instanceof Error ? error : new Error(String(error)),
        });
      },
    ),
  );

/**
 * Creates a worker adapter with the given configuration and processor
 */
interface WorkerAdapterImpl<T extends BaseJobData> {
  worker: Worker<T>;
  start: () => TE.TaskEither<QueueError, void>;
  stop: () => TE.TaskEither<QueueError, void>;
  isRunning: () => boolean;
  getState: () => WorkerStateData;
  reset: () => TE.TaskEither<QueueError, void>;
}

export const createWorkerAdapter = <T extends BaseJobData>(
  queueName: string,
  processor: JobProcessor<T>,
): TE.TaskEither<QueueError, WorkerAdapter<T>> =>
  pipe(
    TE.tryCatch(
      async () => {
        const context = await createWorkerContext(queueName, processor);
        const { worker, state } = context;

        console.debug('[Worker Create] Worker adapter created successfully');

        const adapter: WorkerAdapter<T> = {
          worker,
          start: () => handleWorkerStart(context),
          stop: () => handleWorkerStop(context),
          isRunning: () => state.isRunning && !state.isClosing,
          getState: () => ({ ...state }), // Add getter for state inspection
          reset: () => handleWorkerReset(context),
        };

        return adapter;
      },
      (error) => {
        console.debug('[Worker Create] Error creating worker adapter:', {
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                }
              : error,
        });
        return createStandardQueueError({
          code: QueueErrorCode.PROCESSING_ERROR,
          message: error instanceof Error ? error.message : String(error),
          queueName,
          operation: QueueOperation.GET_WORKER,
          cause: error instanceof Error ? error : new Error(String(error)),
        });
      },
    ),
  );
