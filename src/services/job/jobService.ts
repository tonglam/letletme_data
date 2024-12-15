import { Job, JobsOptions, Queue, QueueEvents, Worker } from 'bullmq';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import {
  QUEUE_CONFIG,
  QUEUE_NAMES,
  QueueName,
  WORKER_CONFIG,
} from '../../infrastructure/queue/config';
import { JobDefinition, JobOptions, JobResult } from '../../jobs/types';

// Types
type JobQueues = Partial<Record<QueueName, Queue>>;
type JobWorkers = Partial<Record<QueueName, Worker>>;
type QueueEventMap = Partial<Record<QueueName, QueueEvents>>;
type JobDefinitionMap = Record<string, JobDefinition>;

// State interfaces (immutable)
interface JobServiceState {
  readonly queues: JobQueues;
  readonly workers: JobWorkers;
  readonly queueEvents: QueueEventMap;
  readonly jobDefinitions: JobDefinitionMap;
}

// Initialize empty state
const createEmptyState = (): JobServiceState => ({
  queues: {},
  workers: {},
  queueEvents: {},
  jobDefinitions: {},
});

// Pure function to create a queue
const createQueue = (queueName: QueueName): E.Either<Error, Queue> =>
  E.tryCatch(
    () => new Queue(queueName, QUEUE_CONFIG),
    (error) => new Error(`Failed to create queue ${queueName}: ${error}`),
  );

// Pure function to create a worker
const createWorker = (
  queueName: QueueName,
  processJob: (job: Job) => Promise<JobResult<unknown>>,
): E.Either<Error, Worker> =>
  E.tryCatch(
    () =>
      new Worker(queueName, processJob, {
        ...WORKER_CONFIG,
        autorun: true,
      }),
    (error) => new Error(`Failed to create worker ${queueName}: ${error}`),
  );

// Pure function to create queue events
const createQueueEvents = (queueName: QueueName): E.Either<Error, QueueEvents> =>
  E.tryCatch(
    () => new QueueEvents(queueName, { connection: QUEUE_CONFIG.connection }),
    (error) => new Error(`Failed to create queue events ${queueName}: ${error}`),
  );

// Initialize queues, workers, and events
const initializeJobInfrastructure = (
  processJob: (job: Job) => Promise<JobResult<unknown>>,
): TE.TaskEither<Error, JobServiceState> =>
  pipe(
    Object.values(QUEUE_NAMES),
    TE.traverseArray((queueName) =>
      pipe(
        TE.fromEither(createQueue(queueName)),
        TE.bindTo('queue'),
        TE.bind('worker', () => TE.fromEither(createWorker(queueName, processJob))),
        TE.bind('events', () => TE.fromEither(createQueueEvents(queueName))),
        TE.map((result) => ({ queueName, ...result })),
      ),
    ),
    TE.map((results) =>
      results.reduce(
        (state, { queueName, queue, worker, events }) => ({
          ...state,
          queues: { ...state.queues, [queueName]: queue },
          workers: { ...state.workers, [queueName]: worker },
          queueEvents: { ...state.queueEvents, [queueName]: events },
        }),
        createEmptyState(),
      ),
    ),
  );

// Register a job definition
export const registerJob = (
  state: JobServiceState,
  name: string,
  definition: JobDefinition,
): E.Either<Error, JobServiceState> =>
  pipe(
    E.right(state),
    E.map((state) => ({
      ...state,
      jobDefinitions: { ...state.jobDefinitions, [name]: definition },
    })),
  );

// Add a job to the queue
export const addJob = <TData>(
  state: JobServiceState,
  name: string,
  data: TData,
  options?: JobOptions,
): TE.TaskEither<Error, Job<TData, JobResult<unknown>>> =>
  pipe(
    E.fromNullable(new Error(`No job definition found for ${name}`))(state.jobDefinitions[name]),
    TE.fromEither,
    TE.chain((jobDefinition) =>
      pipe(
        E.fromNullable(new Error(`No queue found for ${jobDefinition.metadata.queue}`))(
          state.queues[jobDefinition.metadata.queue],
        ),
        TE.fromEither,
        TE.chain((queue) =>
          TE.tryCatch(
            () =>
              queue.add(name, data, {
                priority: options?.priority ?? jobDefinition.metadata.priority,
                attempts: options?.attempts ?? QUEUE_CONFIG.defaultJobOptions?.attempts ?? 3,
                backoff: options?.backoff ?? QUEUE_CONFIG.defaultJobOptions?.backoff,
              } as JobsOptions),
            (error) => new Error(`Failed to add job to queue: ${error}`),
          ),
        ),
      ),
    ),
  );

// Shutdown all queues, workers, and events
export const shutdown = (state: JobServiceState): TE.TaskEither<Error, void> =>
  pipe(
    TE.sequenceArray([
      ...Object.values(state.workers).map((worker) =>
        TE.tryCatch(
          () => worker?.close(),
          (error) => new Error(`Failed to close worker: ${error}`),
        ),
      ),
      ...Object.values(state.queues).map((queue) =>
        TE.tryCatch(
          () => queue?.close(),
          (error) => new Error(`Failed to close queue: ${error}`),
        ),
      ),
      ...Object.values(state.queueEvents).map((events) =>
        TE.tryCatch(
          () => events?.close(),
          (error) => new Error(`Failed to close queue events: ${error}`),
        ),
      ),
    ]),
    TE.map(() => undefined),
  );

// Create the job service
export const createJobService = (
  processJob: (job: Job) => Promise<JobResult<unknown>>,
): TE.TaskEither<Error, JobServiceState> => initializeJobInfrastructure(processJob);
