# Queue Layer Implementation Guide

## Directory Structure

```plaintext
src/
├── infrastructure/
│   └── queue/
│       ├── core/
│       │   ├── queue.service.ts     # Queue service implementation
│       │   ├── worker.service.ts    # Worker service implementation
│       │   ├── flow.service.ts      # Flow service implementation
│       │   └── scheduler.service.ts  # Scheduler service implementation
│       ├── types.ts                 # Queue-related types
│       └── index.ts                 # Public exports
└── queue/
    ├── meta/                        # Meta job implementations
    │   ├── event/                   # Event-specific jobs
    │   ├── phase/                   # Phase-specific jobs
    │   └── team/                    # Team-specific jobs
    ├── live/                        # Live update jobs
    └── daily/                       # Daily update jobs
```

## Core Service Implementations

### 1. Queue Service (`core/queue.service.ts`)

```typescript
export const createQueueService = <T extends BaseJobData>(
  config: QueueConfig,
  processor: JobProcessor<T>,
): TE.TaskEither<QueueError, QueueService<T>> =>
  pipe(
    TE.Do,
    TE.bind('queue', () => createQueue(config)),
    TE.bind('worker', () => createWorker(config, processor)),
    TE.map(({ queue, worker }) => ({
      addJob: (data: T, options?: JobOptions) =>
        pipe(
          TE.tryCatch(
            () => queue.add(config.name, data, options),
            (error) => createQueueError('QUEUE_OPERATION_ERROR', error as Error),
          ),
          TE.map(() => undefined),
        ),
      addBulk: (jobs: Array<{ data: T; options?: JobOptions }>) =>
        pipe(
          TE.tryCatch(
            () =>
              queue.addBulk(
                jobs.map((job) => ({
                  name: config.name,
                  data: job.data,
                  opts: job.options,
                })),
              ),
            (error) => createQueueError('QUEUE_OPERATION_ERROR', error as Error),
          ),
          TE.map(() => undefined),
        ),
      // ... other methods
    })),
  );
```

### 2. Worker Service (`core/worker.service.ts`)

```typescript
export const createWorkerService = <T extends BaseJobData>(
  config: QueueConfig,
  processor: JobProcessor<T>,
  options: WorkerOptions = {},
): TE.TaskEither<QueueError, WorkerService<T>> =>
  pipe(
    TE.Do,
    TE.bind('worker', () =>
      TE.tryCatch(
        () =>
          new Worker(
            config.name,
            async (job) => {
              const result = await processor(job)();
              if (result._tag === 'Left') {
                throw result.left;
              }
            },
            {
              connection: config.connection,
              concurrency: options.concurrency,
              maxStalledCount: options.maxStalledCount,
              stalledInterval: options.stalledInterval,
            },
          ),
        (error) => createQueueError('WORKER_ERROR', error as Error),
      ),
    ),
    TE.map((deps) => ({
      start: () =>
        TE.tryCatch(
          () => Promise.resolve(deps.worker.run()),
          (error) => createQueueError('WORKER_ERROR', error as Error),
        ),
      stop: () =>
        TE.tryCatch(
          () => deps.worker.close(),
          (error) => createQueueError('WORKER_ERROR', error as Error),
        ),
      // ... other methods
    })),
  );
```

### 3. Flow Service (`core/flow.service.ts`)

```typescript
export const createFlowService = <T extends BaseJobData>(
  config: QueueConfig,
): TE.TaskEither<QueueError, FlowService<T>> =>
  pipe(
    TE.Do,
    TE.bind('flow', () => createFlowProducer(config)),
    TE.map((deps) => ({
      addJob: (data: T, opts?: FlowOpts<T>) =>
        pipe(
          TE.tryCatch(
            () =>
              deps.flow.add({
                name: opts?.name || config.name,
                queueName: config.name,
                data,
                opts: {
                  jobId: opts?.jobId,
                  priority: opts?.priority,
                  delay: opts?.delay,
                  timestamp: opts?.timestamp,
                  parent: opts?.parent,
                },
                children: opts?.children,
              }),
            (error) => createQueueError('QUEUE_OPERATION_ERROR', error as Error),
          ),
        ),
      // ... other methods
    })),
  );
```

### 4. Scheduler Service (`core/scheduler.service.ts`)

```typescript
export const createSchedulerService = <T extends BaseJobData>(
  config: QueueConfig,
): TE.TaskEither<QueueError, SchedulerService<T>> =>
  pipe(
    TE.Do,
    TE.bind('queue', () => createQueue(config)),
    TE.map((deps) => ({
      upsertJobScheduler: (
        schedulerId: string,
        scheduleOptions: JobSchedulerOptions,
        template?: JobTemplate<T>,
      ) =>
        pipe(
          TE.tryCatch(
            () =>
              deps.queue.add(template?.name || config.name, template?.data || {}, {
                jobId: schedulerId,
                repeat: {
                  pattern: scheduleOptions.pattern,
                  every: scheduleOptions.every,
                  limit: scheduleOptions.limit,
                },
                ...template?.opts,
              }),
            (error) => createQueueError('QUEUE_OPERATION_ERROR', error as Error),
          ),
          TE.map(() => undefined),
        ),
      // ... other methods
    })),
  );
```

## Job Implementation Examples

### 1. Event Job Processor

```typescript
export const createEventProcessor =
  (eventService: EventService): JobProcessor<EventJobData> =>
  (job: Job<EventJobData>) =>
    pipe(
      TE.Do,
      TE.bind('operation', () => validateOperation(job.data.data.operation)),
      TE.chain(({ operation }) => {
        switch (operation) {
          case 'SYNC':
            return pipe(
              eventService.syncEventsFromApi(),
              TE.mapLeft((error) => createQueueError('JOB_PROCESSING_ERROR', error as Error)),
              TE.map(() => undefined),
            );
          default:
            return TE.left(
              createQueueError(
                'JOB_PROCESSING_ERROR',
                new Error(`Unknown operation: ${operation}`),
              ),
            );
        }
      }),
    );
```

### 2. Job Flow Example

```typescript
export const createEventSyncFlow = (
  flowService: FlowService<EventJobData>,
): TE.TaskEither<QueueError, FlowJob<EventJobData>> =>
  flowService.addJob(
    {
      type: 'META',
      timestamp: new Date(),
      data: {
        operation: 'SYNC',
        type: 'EVENTS',
      },
    },
    {
      jobId: `event-sync-${Date.now()}`,
      children: [
        {
          name: 'event-validation',
          queueName: 'event-validation',
          data: {
            type: 'META',
            timestamp: new Date(),
            data: {
              operation: 'VALIDATE',
              type: 'EVENTS',
            },
          },
        },
      ],
    },
  );
```

## Error Handling

```typescript
const handleQueueError = (error: QueueError): TE.TaskEither<QueueError, void> => {
  logger.error({ error }, 'Queue error occurred');

  switch (error.code) {
    case 'QUEUE_CONNECTION_ERROR':
      return pipe(
        reconnectQueue(),
        TE.chain(() => retryOperation()),
      );
    case 'JOB_PROCESSING_ERROR':
      return pipe(
        notifyError(error),
        TE.chain(() => scheduleRetry()),
      );
    default:
      return TE.left(error);
  }
};
```

## Testing

### 1. Unit Tests

```typescript
describe('Event Processor', () => {
  it('should process sync operation', async () => {
    const mockEventService = createMockEventService();
    const processor = createEventProcessor(mockEventService);

    const result = await processor({
      data: {
        type: 'META',
        timestamp: new Date(),
        data: {
          operation: 'SYNC',
          type: 'EVENTS',
        },
      },
    } as Job<EventJobData>)();

    expect(E.isRight(result)).toBe(true);
    expect(mockEventService.syncEventsFromApi).toHaveBeenCalled();
  });
});
```

### 2. Integration Tests

```typescript
describe('Event Queue Integration', () => {
  beforeEach(async () => {
    await redis.flushDb();
  });

  it('should process event sync job', async () => {
    const queueService = await createQueueService(config, processor)();
    const result = await queueService.addJob({
      type: 'META',
      timestamp: new Date(),
      data: {
        operation: 'SYNC',
        type: 'EVENTS',
      },
    })();

    expect(E.isRight(result)).toBe(true);
    // Verify job completion and side effects
  });
});
```

## Best Practices

### 1. Type Safety

- Use branded types for job IDs
- Define explicit job data types
- Validate job data at runtime
- Use type guards for narrowing

### 2. Error Handling

- Use TaskEither for all operations
- Define specific error types
- Implement retry strategies
- Log errors with context

### 3. Performance

- Configure appropriate concurrency
- Implement job batching
- Use connection pooling
- Monitor queue metrics

### 4. Testing

- Mock Redis for unit tests
- Test error scenarios
- Verify job completion
- Test retry mechanisms

```

```
