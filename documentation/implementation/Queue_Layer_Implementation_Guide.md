# Queue Layer Implementation Guide

## Directory Structure

```
src/
├── infrastructures/
│   └── queue/                      # Queue infrastructure layer
│       ├── core/                   # Core queue infrastructure
│       │   ├── queue.adapter.ts    # BullMQ queue integration
│       │   ├── worker.adapter.ts   # BullMQ worker integration
│       │   ├── queue.service.ts    # Queue operations service
│       │   └── worker.service.ts   # Worker management service
│       ├── types/                  # Queue-related types
│       │   ├── job.types.ts        # Job-specific types
│       │   └── queue.types.ts      # Queue-specific types
│       └── index.ts                # Public exports
├── types/                          # Centralized type definitions
│   ├── queue.type.ts              # Queue-related types
│   └── job.type.ts                # Job-related types
└── queues/                         # Queue implementation layer
    ├── meta/                       # Meta jobs group
    │   ├── core/                   # Core meta job functionality
    │   │   ├── meta.processor.ts   # Meta job processor
    │   │   └── meta.service.ts     # Meta job service
    │   └── events/                 # Events-specific jobs
    │       ├── events.processor.ts # Events processor
    │       └── events.service.ts   # Events service
    ├── live/                       # Live update jobs
    └── daily/                      # Daily update jobs

```

## Type Management

### 1. Centralized Job Types (`src/types/job.type.ts`)

```typescript
import { BaseJobData } from '@infrastructures/queue/types';

// Job Operation Types
export type JobOperation = 'SYNC' | 'UPDATE' | 'CLEANUP';

// Job Types
export type JobType = 'META' | 'LIVE' | 'DAILY';

// Meta Job Types
export type MetaJobType = 'EVENTS' | 'PHASES' | 'TEAMS';

// Meta Job Data
export interface MetaJobData extends BaseJobData {
  readonly type: JobType.META;
  readonly data: {
    readonly operation: JobOperation;
    readonly type: MetaJobType;
  };
}

// Events Job Data (specific implementation of MetaJobData)
export interface EventsJobData extends MetaJobData {
  readonly data: {
    readonly operation: JobOperation;
    readonly type: MetaJobType.EVENTS;
  };
}
```

### 2. Events Service (`queues/jobs/meta/events/events.service.ts`)

```typescript
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { EventsJobData, JobType, MetaJobType } from '@types/job.type';
import { QueueService } from '@infrastructures/queue/core/queue.service';

export interface EventsJobService {
  readonly syncEvents: () => TE.TaskEither<QueueError, void>;
}

export const createEventsJobService = (
  queueService: QueueService<EventsJobData>,
): EventsJobService => ({
  syncEvents: () =>
    queueService.addJob({
      type: JobType.META,
      timestamp: new Date(),
      data: {
        operation: 'SYNC',
        type: MetaJobType.EVENTS,
      },
    }),
});
```

### 3. Events Processor (`queues/jobs/meta/events/events.processor.ts`)

```typescript
import { Job } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { EventsJobData } from '@types/job.type';
import { JobProcessor } from '@infrastructures/queue/types';
import { EventWorkflows } from '@services/events/workflow';
import { getQueueLogger } from '@infrastructures/logger';

const logger = getQueueLogger();

export const createEventsProcessor =
  (
    eventWorkflows: EventWorkflows, // Inject the actual workflow service
  ): JobProcessor<EventsJobData> =>
  (job: Job<EventsJobData>) =>
    pipe(
      TE.tryCatch(
        async () => {
          const { data } = job.data;
          logger.info({ jobId: job.id, operation: data.operation }, 'Processing events job');

          switch (data.operation) {
            case 'SYNC':
              // Use the actual workflow service for syncing
              const result = await eventWorkflows.syncEvents()();
              if (result._tag === 'Left') {
                throw result.left;
              }
              break;
            default:
              throw new Error(`Unknown operation: ${data.operation}`);
          }
        },
        (error) => createQueueError('PROCESS_JOB', error as Error),
      ),
    );

// Usage example showing the complete integration
const initializeEventsQueue = (
  queueConfig: QueueConfig,
  eventService: EventService, // Inject the event service
) => {
  // Create the workflow service
  const workflows = eventWorkflows(eventService);

  // Create the queue service with the processor
  return pipe(
    createQueueService(queueConfig, createEventsProcessor(workflows)),
    TE.map((queueService) => ({
      queueService,
      jobService: createEventsJobService(queueService),
    })),
  );
};
```

This integration demonstrates:

1. Using the actual workflow service for business logic
2. Proper error handling and logging
3. Clean separation between queue processing and business logic
4. Type-safe integration of services

### 4. Usage Example

```typescript
// Initialize events queue service
const eventsQueueConfig = createQueueConfig(QUEUE_NAMES.META_EVENTS);
const eventsQueueService = await createQueueService(
  eventsQueueConfig,
  createEventsProcessor(eventsService),
)();

// Create events job service
const eventsJobService = createEventsJobService(eventsQueueService);

// Schedule events sync
await eventsJobService.syncEvents()();
```

This example demonstrates:

1. Clear separation of concerns:
   - Infrastructure (queue/worker) in `/infrastructures/queue`
   - Job implementation in `/queues/jobs/meta/events`
2. Type safety through job-specific types
3. Functional approach using `fp-ts`
4. Clean service and processor organization

## Queue Pattern Implementations

### 1. Single Queue-Single Worker (1:1)

```typescript
// Basic queue adapter type
interface QueueAdapter<T extends BaseJobData> {
  readonly queue: Queue;
  readonly addJob: (data: T) => TE.TaskEither<QueueError, Job<T>>;
  readonly removeJob: (jobId: string) => TE.TaskEither<QueueError, void>;
}

// Basic worker adapter type
interface WorkerAdapter<T extends BaseJobData> {
  readonly worker: Worker;
  readonly start: () => TE.TaskEither<QueueError, void>;
  readonly stop: () => TE.TaskEither<QueueError, void>;
}

// Basic implementation
const createBasicQueue = <T extends BaseJobData>(
  name: string,
  processor: JobProcessor<T>,
): TE.TaskEither<QueueError, QueueService<T>> =>
  pipe(
    TE.Do,
    TE.bind('queue', () => createQueueAdapter<T>(name)),
    TE.bind('worker', () => createWorkerAdapter(name, processor)),
    TE.map(({ queue, worker }) => ({
      addJob: queue.addJob,
      removeJob: queue.removeJob,
      startWorker: worker.start,
      stopWorker: worker.stop,
    })),
  );
```

### 2. Single Queue-Multiple Workers (1:N)

```typescript
// Multi-worker adapter type
interface MultiWorkerAdapter<T extends BaseJobData> {
  readonly workers: Worker[];
  readonly start: () => TE.TaskEither<QueueError, void>;
  readonly stop: () => TE.TaskEither<QueueError, void>;
}

// Implementation for I/O intensive operations
const createScalableQueue = <T extends BaseJobData>(
  name: string,
  processor: JobProcessor<T>,
  options: {
    numWorkers: number;
    concurrency: number;
  },
): TE.TaskEither<QueueError, ScalableQueueService<T>> =>
  pipe(
    TE.Do,
    TE.bind('queue', () => createQueueAdapter<T>(name)),
    TE.bind('workers', () =>
      pipe(
        Array.from({ length: options.numWorkers }, () =>
          createWorkerAdapter(name, processor, {
            concurrency: options.concurrency,
          }),
        ),
        TE.sequenceArray,
      ),
    ),
    TE.map(({ queue, workers }) => ({
      addJob: queue.addJob,
      removeJob: queue.removeJob,
      startWorkers: () => TE.sequenceArray(workers.map((w) => w.start())),
      stopWorkers: () => TE.sequenceArray(workers.map((w) => w.stop())),
    })),
  );
```

### 3. Multiple Queues-Single Worker (N:1)

```typescript
// Sequential queue adapter type
interface SequentialQueueAdapter<T extends BaseJobData> {
  readonly queues: Record<string, Queue>;
  readonly addJob: (queueName: string, data: T) => TE.TaskEither<QueueError, Job<T>>;
  readonly removeJob: (queueName: string, jobId: string) => TE.TaskEither<QueueError, void>;
}

// Implementation for sequential processing
const createSequentialQueues = <T extends BaseJobData>(
  queueNames: string[],
  processor: JobProcessor<T>,
  options: {
    priorities?: Record<string, number>;
  } = {},
): TE.TaskEither<QueueError, SequentialQueueService<T>> =>
  pipe(
    TE.Do,
    TE.bind('queues', () =>
      pipe(
        queueNames,
        TE.traverseArray((name) =>
          createQueueAdapter<T>(name, {
            defaultJobOptions: {
              priority: options.priorities?.[name],
            },
          }),
        ),
      ),
    ),
    TE.bind('worker', () =>
      createWorkerAdapter(queueNames, processor, {
        concurrency: 1,
      }),
    ),
    TE.map(({ queues, worker }) => ({
      addJob: (queueName: string, data: T) =>
        pipe(
          TE.fromOption(() => createQueueError('QUEUE_NOT_FOUND'))(queues[queueName]),
          TE.chain((queue) => queue.addJob(data)),
        ),
      removeJob: (queueName: string, jobId: string) =>
        pipe(
          TE.fromOption(() => createQueueError('QUEUE_NOT_FOUND'))(queues[queueName]),
          TE.chain((queue) => queue.removeJob(jobId)),
        ),
      startWorker: worker.start,
      stopWorker: worker.stop,
    })),
  );
```

### Configuration Examples

```typescript
import {
  QueueConfig,
  QUEUE_NAMES,
  QUEUE_CONSTANTS,
  createQueueConfig,
  JOB_SCHEDULES,
} from '@configs/queue/queue.config';

// 1. Basic Queue Configuration
const metaQueueConfig = createQueueConfig(QUEUE_NAMES.META);

// 2. I/O Intensive Queue Configuration (1:N)
const createScalableQueueConfig = (queueName: string) => ({
  ...createQueueConfig(queueName),
  options: {
    numWorkers: 3,
    concurrency: 5,
    attempts: QUEUE_CONSTANTS.ATTEMPTS.HIGH,
    backoff: QUEUE_CONSTANTS.BACKOFF,
    removeOnComplete: true,
    lockDuration: QUEUE_CONSTANTS.LOCK_DURATION,
  },
});

// Example usage for data processing
const dataProcessingQueue = await createScalableQueue(
  QUEUE_NAMES.META,
  dataProcessor,
  createScalableQueueConfig(QUEUE_NAMES.META).options,
)();

// 3. Sequential Queue Configuration (N:1)
const createSequentialQueueConfigs = (queueNames: string[]) =>
  queueNames.map((name, index) => ({
    ...createQueueConfig(name),
    options: {
      priority: index + 1, // Priority based on order
      attempts: QUEUE_CONSTANTS.ATTEMPTS.MEDIUM,
      backoff: QUEUE_CONSTANTS.BACKOFF,
    },
  }));

// Example usage for workflow
const workflowQueues = await createSequentialQueues(
  [QUEUE_NAMES.META, QUEUE_NAMES.LIVE],
  workflowProcessor,
  {
    priorities: {
      [QUEUE_NAMES.META]: QUEUE_CONSTANTS.PRIORITIES.HIGH,
      [QUEUE_NAMES.LIVE]: QUEUE_CONSTANTS.PRIORITIES.MEDIUM,
    },
  },
)();

// 4. Scheduled Job Configuration
const scheduleMetaJob = (queueService: QueueService<MetaJobData>) => {
  // Use predefined schedule from config
  return scheduleJob(
    queueService,
    JOB_SCHEDULES.META_UPDATE, // '35 6 * * *' (6:35 AM UTC daily)
    {
      type: 'META',
      data: {
        operation: 'SYNC',
        type: 'EVENTS',
      },
    },
  );
};
```

Key points about configuration:

1. **Use Predefined Constants**:

   - `QUEUE_NAMES` for queue identification
   - `QUEUE_CONSTANTS` for queue settings
   - `JOB_SCHEDULES` for cron patterns

2. **Queue Configuration Factory**:

   - Use `createQueueConfig` for base configuration
   - Extend with specific options as needed

3. **Priority Management**:

   ```typescript
   QUEUE_CONSTANTS.PRIORITIES: {
     HIGH: 1,
     MEDIUM: 2,
     LOW: 3
   }
   ```

4. **Retry Strategy**:

   ```typescript
   QUEUE_CONSTANTS.ATTEMPTS: {
     HIGH: 5,
     MEDIUM: 3,
     LOW: 1
   }
   ```

5. **Job Scheduling**:
   ```typescript
   JOB_SCHEDULES: {
     META_UPDATE: '35 6 * * *',
     LIVE_UPDATE: '*/1 * * * *',
     // ...
   }
   ```

Remember:

- Always use configuration from `queue.config.ts`
- Don't hardcode queue names or settings
- Use appropriate constants for different queue types
- Follow the predefined scheduling patterns

## Error Handling and Monitoring

```typescript
import {
  QueueError,
  QueueErrorCode,
  ServiceError,
  createQueueError,
  createServiceError,
  createServiceOperationError,
} from '@types/errors.type';
import { createQueueProcessingError, createQueueConnectionError } from '@utils/error.util';

// Example of proper error handling in processor
export const createEventsProcessor =
  (eventWorkflows: EventWorkflows): JobProcessor<EventsJobData> =>
  (job: Job<EventsJobData>) =>
    pipe(
      TE.tryCatch(
        async () => {
          const { data } = job.data;

          // Handle workflow errors
          const result = await eventWorkflows.syncEvents()();
          if (result._tag === 'Left') {
            // Convert service errors to queue errors
            throw createQueueProcessingError({
              message: `Event sync failed: ${result.left.message}`,
              queueName: 'meta-events',
              cause: result.left,
            });
          }
        },
        (error) => {
          // Use existing error utilities
          if (error instanceof Error) {
            return createQueueError(QueueErrorCode.JOB_PROCESSING_ERROR, 'meta-events', error);
          }
          return createQueueProcessingError({
            message: 'Unknown error during job processing',
            queueName: 'meta-events',
          });
        },
      ),
    );

// Example of connection error handling
const initializeQueue = (config: QueueConfig) =>
  pipe(
    TE.tryCatch(
      () => connectToRedis(config),
      (error) =>
        createQueueConnectionError({
          message: 'Failed to connect to Redis',
          queueName: config.name,
          cause: error as Error,
        }),
    ),
  );

// Example of monitoring with error tracking
const setupQueueMonitoring = (queue: Queue, worker: Worker) => {
  // Error metrics with proper error typing
  worker.on('failed', (job, error) => {
    if (error instanceof Error) {
      const queueError = createQueueProcessingError({
        message: error.message,
        queueName: queue.name,
        cause: error,
      });
      logger.error({ error: queueError }, 'Job processing failed');
      metrics.recordJobFailure(worker.name, queueError);
    }
  });
};
```

Key points about error handling:

1. **Use Existing Error Types**:

   - `QueueError` for queue-related errors
   - `ServiceError` for service-level errors
   - Proper error code enums (`QueueErrorCode`, `ServiceErrorCode`)

2. **Use Error Utilities**:

   - `createQueueError` for basic queue errors
   - `createQueueProcessingError` for job processing errors
   - `createQueueConnectionError` for connection issues
   - `createServiceError` for service-level errors

3. **Error Conversion**:

   - Convert service errors to queue errors when crossing boundaries
   - Maintain error chain using `cause` property
   - Preserve error context and details

4. **Error Logging**:

   - Use structured logging with error types
   - Include relevant context (queue name, job ID)
   - Maintain error hierarchy

5. **Error Monitoring**:
   - Track errors by type and queue
   - Monitor error rates and patterns
   - Alert on error thresholds

Remember:

- Never create new error types - use existing ones from `@types/errors.type.ts`
- Use error utilities from `@utils/error.util.ts`
- Maintain proper error hierarchy and context
- Always include appropriate error codes

## Best Practices

1. **Type Safety**

   - Always use proper typing for job data
   - Define clear interfaces for queue and worker adapters
   - Use TypeScript's strict mode

2. **Error Handling**

   - Use TaskEither for all operations
   - Implement proper error recovery strategies
   - Log errors with context

3. **Resource Management**

   - Configure appropriate concurrency levels
   - Monitor memory usage
   - Implement graceful shutdown

4. **Monitoring**

   - Track queue lengths
   - Monitor worker health
   - Set up alerts for anomalies

5. **Testing**
   - Mock Redis for unit tests
   - Test error scenarios
   - Verify job processing logic

Remember to:

- Keep job processors pure and isolated
- Handle errors gracefully
- Monitor queue health
- Scale based on metrics
- Test thoroughly

```

```
