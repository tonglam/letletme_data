# FP-Based Job System Examples

## 1. Basic Setup

```typescript
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createJobService, createScheduler } from '../services/job';
import { BootstrapJob } from '../jobs/meta/BootstrapJob';

// Initialize the job system
const initializeJobSystem = pipe(
  // Create job service
  createJobService(processJob),
  TE.chain((jobService) =>
    pipe(
      // Create scheduler
      E.right(createScheduler()),
      // Register bootstrap job
      E.chain((scheduler) =>
        registerScheduledJob(scheduler, 'bootstrap', BootstrapJob, () =>
          addJob(jobService, 'bootstrap', { validateMeta: true, updateTypes: ['teams'] }),
        ),
      ),
      TE.fromEither,
      // Start all jobs
      TE.chain((scheduler) => pipe(startAllJobs(scheduler), TE.fromEither)),
    ),
  ),
);

// Handle initialization result
initializeJobSystem().then(
  E.fold(
    (error) => console.error('Failed to initialize job system:', error),
    () => console.log('Job system initialized successfully'),
  ),
);
```

## 2. Job Definition Example

```typescript
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { z } from 'zod';
import { JobDefinition } from '../jobs/types';

// Input validation schema
const DataSchema = z.object({
  id: z.string(),
  data: z.unknown(),
});

type JobData = z.infer<typeof DataSchema>;

// Result type
interface JobResult {
  processed: boolean;
  timestamp: number;
}

// Job implementation
export const ExampleJob: JobDefinition<JobData, JobResult> = {
  metadata: {
    queue: 'default',
    priority: 'medium',
    schedule: '*/15 * * * *', // Every 15 minutes
    timeout: 60000, // 1 minute
  },

  validate: (data: unknown) =>
    pipe(
      E.tryCatch(
        () => DataSchema.parse(data),
        (error) => new Error(`Invalid data: ${error}`),
      ),
    ),

  handler: async (data: JobData) =>
    pipe(
      TE.right(data),
      TE.chain((data) =>
        TE.tryCatch(
          async () => ({
            processed: true,
            timestamp: Date.now(),
          }),
          (error) => new Error(`Processing failed: ${error}`),
        ),
      ),
    )(),

  onComplete: async (result: JobResult) => {
    console.log('Job completed:', result);
  },

  onFailed: async (error: Error) => {
    console.error('Job failed:', error);
  },
};
```

## 3. Common Operations

```typescript
// Add a job
const addJobExample = (jobService: JobServiceState) =>
  pipe(
    addJob(jobService, 'example', { id: '123', data: { value: 'test' } }, { priority: 'high' }),
    TE.fold(
      (error) => console.error('Failed to add job:', error),
      (job) => console.log('Job added:', job.id),
    ),
  );

// Get job status
const checkJobStatus = (scheduler: SchedulerState, jobName: string) =>
  pipe(
    getJobStatus(scheduler, jobName),
    O.fold(
      () => console.log('Job not found'),
      (status) => console.log('Job status:', status),
    ),
  );

// Stop all jobs
const stopJobs = (scheduler: SchedulerState) =>
  pipe(
    stopAllJobs(scheduler),
    E.fold(
      (error) => console.error('Failed to stop jobs:', error),
      (newState) => console.log('All jobs stopped'),
    ),
  );
```

## 4. Error Handling

```typescript
// Utility for handling TaskEither results
const handleTaskResult = <T>(
  task: TE.TaskEither<Error, T>,
  onSuccess: (result: T) => void,
  onError: (error: Error) => void = console.error,
) => task().then(E.fold(onError, onSuccess));

// Example usage
handleTaskResult(
  addJob(jobService, 'example', data),
  (job) => console.log('Job added:', job.id),
  (error) => {
    console.error('Failed to add job:', error);
    // Additional error handling...
  },
);
```

## 5. Composing Operations

```typescript
// Compose multiple operations
const composeOperations = (jobService: JobServiceState, scheduler: SchedulerState) =>
  pipe(
    // Register job
    registerJob(jobService, 'example', ExampleJob),
    TE.fromEither,
    // Register scheduled execution
    TE.chain((updatedService) =>
      pipe(
        registerScheduledJob(scheduler, 'example', ExampleJob, () =>
          addJob(updatedService, 'example', { id: 'scheduled', data: {} }),
        ),
        TE.fromEither,
      ),
    ),
    // Start jobs
    TE.chain((updatedScheduler) => pipe(startAllJobs(updatedScheduler), TE.fromEither)),
  );
```

## 6. Testing

```typescript
import * as E from 'fp-ts/Either';
import { createJobService, createScheduler } from '../services/job';

describe('Job System', () => {
  it('should initialize successfully', async () => {
    const result = await pipe(
      createJobService(processJob),
      TE.map((service) => {
        expect(service).toBeDefined();
        return service;
      }),
    )();

    expect(E.isRight(result)).toBe(true);
  });

  it('should handle job registration', () => {
    const scheduler = createScheduler();
    const result = registerScheduledJob(scheduler, 'test', ExampleJob, () => Promise.resolve());

    expect(E.isRight(result)).toBe(true);
    if (E.isRight(result)) {
      expect(Object.keys(result.right.cronJobs)).toContain('test');
    }
  });
});
```
