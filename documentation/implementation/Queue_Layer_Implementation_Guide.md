# Queue Layer Implementation Guide

## Directory Structure

```
src/
├── infrastructures/
│   └── queue/                      # Queue infrastructure layer
│       ├── core/
│       │   ├── queue.adapter.ts    # BullMQ queue integration
│       │   └── worker.adapter.ts   # BullMQ worker integration
│       ├── types/                  # Queue-related types
│       │   ├── job.types.ts        # Job-specific types
│       │   └── queue.types.ts      # Queue-specific types
│       └── index.ts                # Public exports
└── queues/                         # Queue implementation layer
    ├── jobs/                       # Job implementations
    │   ├── processors/             # Job processors
    │   │   ├── meta.processor.ts   # Meta job processor
    │   │   ├── live.processor.ts   # Live update processor
    │   │   └── daily.processor.ts  # Daily job processor
    │   └── types/                  # Job-specific types
    └── services/
        ├── queue.service.ts        # Queue operations service
        └── worker.service.ts       # Worker management service
```

## Core Implementation Examples

### 1. Queue Types (`src/infrastructures/queue/types/queue.types.ts`)

```typescript
import { Queue, Worker, Job } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { QueueError } from './errors.types';

export interface BaseJobData {
  readonly type: string;
  readonly timestamp: Date;
  readonly data: unknown;
}

export interface QueueAdapter<T extends BaseJobData> {
  readonly queue: Queue;
  readonly addJob: (data: T) => TE.TaskEither<QueueError, Job<T>>;
  readonly removeJob: (jobId: string) => TE.TaskEither<QueueError, void>;
}

export interface WorkerAdapter<T extends BaseJobData> {
  readonly worker: Worker;
  readonly start: () => TE.TaskEither<QueueError, void>;
  readonly stop: () => TE.TaskEither<QueueError, void>;
}

export type JobProcessor<T extends BaseJobData> = (job: Job<T>) => TE.TaskEither<QueueError, void>;
```

### 2. Queue Adapter (`src/infrastructures/queue/core/queue.adapter.ts`)

```typescript
import { Queue, Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueAdapter, BaseJobData } from '../types/queue.types';
import { QueueError } from '../types/errors.types';
import { createQueueError } from '../utils/error.utils';

export const createQueueAdapter = <T extends BaseJobData>(
  name: string,
  connection: { host: string; port: number },
): TE.TaskEither<QueueError, QueueAdapter<T>> =>
  pipe(
    TE.tryCatch(
      async () => {
        const queue = new Queue(name, {
          connection,
          defaultJobOptions: {
            removeOnComplete: true,
            removeOnFail: false,
          },
        });

        return {
          queue,
          addJob: (data: T) =>
            TE.tryCatch(
              () => queue.add(data.type, data),
              (error) => createQueueError('ADD_JOB', error as Error),
            ),
          removeJob: (jobId: string) =>
            TE.tryCatch(
              async () => {
                const job = await queue.getJob(jobId);
                if (job) {
                  await job.remove();
                }
              },
              (error) => createQueueError('REMOVE_JOB', error as Error),
            ),
        };
      },
      (error) => createQueueError('CREATE_QUEUE', error as Error),
    ),
  );
```

### 3. Worker Adapter (`src/infrastructures/queue/core/worker.adapter.ts`)

```typescript
import { Worker } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { WorkerAdapter, BaseJobData, JobProcessor } from '../types/queue.types';
import { QueueError } from '../types/errors.types';
import { createQueueError } from '../utils/error.utils';

export const createWorkerAdapter = <T extends BaseJobData>(
  name: string,
  connection: { host: string; port: number },
  processor: JobProcessor<T>,
): TE.TaskEither<QueueError, WorkerAdapter<T>> =>
  pipe(
    TE.tryCatch(
      async () => {
        const worker = new Worker(
          name,
          async (job) => {
            const result = await processor(job)();
            if (result._tag === 'Left') {
              throw result.left;
            }
          },
          {
            connection,
            autorun: false,
            concurrency: 1,
          },
        );

        return {
          worker,
          start: () =>
            TE.tryCatch(
              async () => {
                await worker.run();
              },
              (error) => createQueueError('START_WORKER', error as Error),
            ),
          stop: () =>
            TE.tryCatch(
              async () => {
                await worker.close();
              },
              (error) => createQueueError('STOP_WORKER', error as Error),
            ),
        };
      },
      (error) => createQueueError('CREATE_WORKER', error as Error),
    ),
  );
```

### 4. Job Implementation Example (`src/queues/jobs/processors/meta.processor.ts`)

```typescript
import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { MetaJobData } from '../types/meta.types';
import { JobProcessor } from '@infrastructures/queue/types/queue.types';
import { QueueError } from '@infrastructures/queue/types/errors.types';
import { createQueueError } from '@infrastructures/queue/utils/error.utils';

export const createMetaProcessor =
  (metaService: MetaService): JobProcessor<MetaJobData> =>
  (job: Job<MetaJobData>) =>
    pipe(
      TE.tryCatch(
        async () => {
          const { type, data } = job.data;
          switch (type) {
            case 'BOOTSTRAP':
              await metaService.bootstrap(data);
              break;
            case 'PHASES':
              await metaService.updatePhases(data);
              break;
            default:
              throw new Error(`Unknown meta job type: ${type}`);
          }
        },
        (error) => createQueueError('PROCESS_JOB', error as Error),
      ),
    );
```

### 5. Queue Service Usage Example (`src/queues/services/queue.service.ts`)

```typescript
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createQueueAdapter } from '@infrastructures/queue/core/queue.adapter';
import { createWorkerAdapter } from '@infrastructures/queue/core/worker.adapter';
import { createMetaProcessor } from '../jobs/processors/meta.processor';
import { MetaJobData } from '../jobs/types/meta.types';
import { QueueError } from '@infrastructures/queue/types/errors.types';

export const initializeMetaQueue = (
  connection: { host: string; port: number },
  metaService: MetaService,
) =>
  pipe(
    createQueueAdapter<MetaJobData>('meta', connection),
    TE.chain((queueAdapter) =>
      pipe(
        createWorkerAdapter('meta', connection, createMetaProcessor(metaService)),
        TE.map((workerAdapter) => ({
          queueAdapter,
          workerAdapter,
        })),
      ),
    ),
  );

// Usage example
const startMetaQueue = async () => {
  const result = await initializeMetaQueue(
    {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
    },
    metaService,
  )();

  if (result._tag === 'Left') {
    console.error('Failed to initialize meta queue:', result.left);
    return;
  }

  const { queueAdapter, workerAdapter } = result.right;
  await workerAdapter.start()();

  // Add a job
  await queueAdapter.addJob({
    type: 'BOOTSTRAP',
    timestamp: new Date(),
    data: { operation: 'SYNC' },
  })();
};
```

This implementation guide demonstrates:

1. Clean separation of concerns
2. Type-safe job handling
3. Functional programming with fp-ts
4. Simplified BullMQ integration
5. Error handling with TaskEither
6. Modular and maintainable code structure

The examples show how to:

- Define type-safe job data and processors
- Create queue and worker adapters
- Handle errors functionally
- Process jobs with proper typing
- Initialize and use queues in services

Remember to:

1. Always use proper typing for job data
2. Handle errors with TaskEither
3. Keep job processors pure and isolated
4. Use BullMQ's built-in features when possible
5. Follow functional programming principles

```

```
