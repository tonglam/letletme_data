# Queue Layer Implementation Guide

## Directory Structure

```
src/
├── infrastructure/
│   └── queue/                      # Queue infrastructure layer
│       ├── core/
│       │   ├── queue.adapter.ts    # BullMQ queue integration
│       │   └── worker.adapter.ts   # BullMQ worker integration
│       ├── types.ts                # All queue-related types
│       ├── utils.ts                # All queue-related utilities
│       └── index.ts                # Public exports
└── queues/                         # Queue implementation layer
    ├───queues/                     # Job implementations
    │   ├── meta.queue.ts           # Meta data jobs (bootstrap, phases, etc)
    │   ├── live.queue.ts           # Live update jobs
    │   ├── post-match.queue.ts     # Post-match processing jobs
    │   ├── post-gameweek.queue.ts  # Post-gameweek jobs
    │   └── daily.queue.ts          # Daily maintenance jobs
    └── core/
        ├── queue.service.ts        # Queue operations service
        └── worker.service.ts       # Worker management service

# Configuration is in @queue.config.ts
```

## Job Implementation Examples

### 1. Meta Jobs (`src/queues/@queues/meta.queue.ts`)

```typescript
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { Queue } from 'bullmq';
import { Logger } from 'pino';
import { QUEUE_CONSTANTS, JOB_SCHEDULES } from '@queue.config';
import { createSchedule, cleanupJobs } from '@infrastructure/queue/utils';
import { QueueError, BaseJobData } from '@infrastructure/queue/types';

// Job data types
export interface MetaJobData extends BaseJobData {
  readonly type: 'BOOTSTRAP' | 'PHASES' | 'EVENTS' | 'TEAMS';
  readonly data: {
    readonly operation: 'UPDATE' | 'SYNC';
    readonly id?: number;
  };
}

// Meta queue implementation
export const createMetaQueue = (queue: Queue, logger: Logger) => ({
  // Job operations
  addJob: (data: MetaJobData): TE.TaskEither<QueueError, void> =>
    pipe(
      TE.tryCatch(
        () =>
          queue.add(data.type, data, {
            priority: QUEUE_CONSTANTS.PRIORITIES.HIGH,
            attempts: QUEUE_CONSTANTS.ATTEMPTS.HIGH,
          }),
        (error) => ({
          name: 'QueueError',
          message: 'Failed to add meta job',
          queueName: queue.name,
          operation: 'addJob',
          cause: error as Error,
        }),
      ),
      TE.map(() => undefined),
    ),

  // Schedule setup
  setupSchedules: (): TE.TaskEither<QueueError, void> =>
    pipe(
      // Schedule bootstrap job
      createSchedule(
        JOB_SCHEDULES.META_UPDATE,
        {
          type: 'BOOTSTRAP',
          timestamp: new Date(),
          data: { operation: 'SYNC' },
        } as MetaJobData,
        {
          priority: QUEUE_CONSTANTS.PRIORITIES.HIGH,
          attempts: QUEUE_CONSTANTS.ATTEMPTS.HIGH,
        },
      ),
      TE.map(() => logger.info('Meta jobs scheduled')),
    ),

  // Process job
  processJob: (data: MetaJobData): TE.TaskEither<QueueError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          logger.info(`Processing meta job: ${data.type}`);
          // Implement job processing logic here
          // Example: await metaService[data.type.toLowerCase()](data.data);
        },
        (error) => ({
          name: 'QueueError',
          message: 'Failed to process meta job',
          queueName: queue.name,
          operation: 'processJob',
          cause: error as Error,
        }),
      ),
    ),
});
```

### 2. Live Jobs (`src/queues/@queues/live.queue.ts`)

```typescript
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { Queue } from 'bullmq';
import { Logger } from 'pino';
import { QUEUE_CONSTANTS, JOB_SCHEDULES } from '@queue.config';
import { createSchedule } from '@infrastructure/queue/utils';
import { QueueError, BaseJobData } from '@infrastructure/queue/types';

// Job data types
export interface LiveJobData extends BaseJobData {
  readonly type: 'LIVE_SCORE' | 'LIVE_CACHE';
  readonly data: {
    readonly matchId?: number;
    readonly gameweek?: number;
  };
}

// Live queue implementation
export const createLiveQueue = (queue: Queue, logger: Logger) => ({
  // Job operations
  addJob: (data: LiveJobData): TE.TaskEither<QueueError, void> =>
    pipe(
      TE.tryCatch(
        () =>
          queue.add(data.type, data, {
            priority: QUEUE_CONSTANTS.PRIORITIES.HIGH,
            attempts: QUEUE_CONSTANTS.ATTEMPTS.HIGH,
            timeout: 5000, // 5 seconds timeout for live jobs
          }),
        (error) => ({
          name: 'QueueError',
          message: 'Failed to add live job',
          queueName: queue.name,
          operation: 'addJob',
          cause: error as Error,
        }),
      ),
      TE.map(() => undefined),
    ),

  // Schedule setup
  setupSchedules: (): TE.TaskEither<QueueError, void> =>
    pipe(
      createSchedule(
        JOB_SCHEDULES.LIVE_UPDATE,
        {
          type: 'LIVE_CACHE',
          timestamp: new Date(),
          data: {},
        } as LiveJobData,
        {
          priority: QUEUE_CONSTANTS.PRIORITIES.HIGH,
          attempts: QUEUE_CONSTANTS.ATTEMPTS.HIGH,
        },
      ),
      TE.map(() => logger.info('Live jobs scheduled')),
    ),

  // Process job
  processJob: (data: LiveJobData): TE.TaskEither<QueueError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          logger.info(`Processing live job: ${data.type}`);
          // Implement job processing logic here
          // Example: await liveService[data.type.toLowerCase()](data.data);
        },
        (error) => ({
          name: 'QueueError',
          message: 'Failed to process live job',
          queueName: queue.name,
          operation: 'processJob',
          cause: error as Error,
        }),
      ),
    ),
});
```

Each job category (meta, live, post-match, etc.) follows this pattern:

1. Define job-specific data types
2. Create queue operations (add, schedule, process)
3. Use shared utilities from infrastructure layer
4. Implement job-specific processing logic
5. Use configurations from `@queue.config.ts`

The `@queues` directory follows the same pattern as other domain-specific implementations in the project, keeping related functionality together while maintaining separation of concerns.

```

```
