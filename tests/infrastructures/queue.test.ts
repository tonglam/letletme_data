import { Job, Queue, Worker } from 'bullmq';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { createQueueAdapter } from '../../src/infrastructures/queue/core/queue.adapter';
import { createWorkerAdapter } from '../../src/infrastructures/queue/core/worker.adapter';
import { QueueError } from '../../src/types/errors.type';
import {
  BaseJobData,
  JobProcessor,
  QueueAdapter,
  QueueOperation,
  WorkerAdapter,
} from '../../src/types/queue.type';
import { createStandardQueueError } from '../../src/utils/queue.utils';

// Test queue configuration
const TEST_QUEUE = 'test_queue';

// Test job data type
interface TestJobData extends BaseJobData {
  type: 'test-job';
  data: {
    value: string;
  };
}

// Reasonable timeout for queue operations
jest.setTimeout(30000); // 30 seconds for individual tests

// Helper function to wait with timeout
const waitWithTimeout = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper function to wait for job completion
const waitForJobCompletion = async (
  queue: Queue,
  jobId: string,
  maxAttempts = 10,
): Promise<Job | undefined> => {
  let attempts = 0;
  let job = await queue.getJob(jobId);

  while ((!job?.finishedOn || !job?.processedOn) && attempts < maxAttempts) {
    await waitWithTimeout(500);
    job = await queue.getJob(jobId);
    attempts++;
  }

  return job;
};

// Helper function to wait for job failure
const waitForJobFailure = async (
  queue: Queue,
  jobId: string,
  maxAttempts = 10,
): Promise<Job | undefined> => {
  let attempts = 0;
  let job = await queue.getJob(jobId);

  while ((!job?.failedReason || !job?.finishedOn) && attempts < maxAttempts) {
    await waitWithTimeout(500);
    job = await queue.getJob(jobId);
    attempts++;
  }

  return job;
};

// Helper function to wait for job removal
const waitForJobRemoval = async (
  queue: Queue,
  jobId: string,
  maxAttempts = 10,
): Promise<Job | undefined> => {
  let attempts = 0;
  let job = await queue.getJob(jobId);

  while (job && attempts < maxAttempts) {
    await waitWithTimeout(500);
    job = await queue.getJob(jobId);
    attempts++;
  }

  return job;
};

describe('Queue Infrastructure Tests', () => {
  let queueAdapter: QueueAdapter;
  let workerAdapter: WorkerAdapter<TestJobData>;
  let processedJobs: TestJobData[] = [];
  let queue: Queue;
  let worker: Worker;

  const testProcessor: JobProcessor<TestJobData> = (job: Job<TestJobData>) =>
    TE.tryCatch(
      async () => {
        console.log('Processing job:', job.id, job.data);
        processedJobs.push(job.data);
        await job.updateProgress(100);
        console.log('Job processed successfully:', job.id);
        return Promise.resolve();
      },
      (error) => {
        console.error('Job processing error:', error);
        return error as QueueError;
      },
    );

  // Helper function to wait for job processing
  const waitForJobProcessing = async (maxWaitMs = 5000): Promise<void> => {
    const startTime = Date.now();
    console.log('Waiting for job processing...');

    while (Date.now() - startTime < maxWaitMs) {
      if (processedJobs.length > 0) {
        console.log('Job processing completed');
        return;
      }
      if (!workerAdapter.isRunning()) {
        console.error('Worker stopped during job processing');
        throw new Error('Worker stopped unexpectedly');
      }
      await waitWithTimeout(100);
    }
    console.error('Job processing timed out. Worker state:', {
      isRunning: workerAdapter.isRunning(),
      processedJobs,
    });
    throw new Error('Job processing timeout');
  };

  beforeAll(async () => {
    // Set test environment
    process.env.NODE_ENV = 'test';

    try {
      // Create queue adapter with timeout
      console.log('Creating queue adapter...');
      const queuePromise = createQueueAdapter(TEST_QUEUE)();
      const queueResult = await Promise.race([
        queuePromise,
        waitWithTimeout(5000).then(() => {
          throw new Error('Queue adapter creation timed out after 5s');
        }),
      ]);

      if (!E.isRight(queueResult)) {
        console.error('Failed to create queue adapter:', queueResult.left);
        throw new Error('Failed to create queue adapter');
      }
      queueAdapter = queueResult.right;
      queue = queueAdapter.queue;
      console.log('Queue adapter created successfully');

      // Create worker adapter with timeout
      console.log('Creating worker adapter...');
      const workerPromise = createWorkerAdapter(TEST_QUEUE, testProcessor)();
      const workerResult = await Promise.race([
        workerPromise,
        waitWithTimeout(5000).then(() => {
          throw new Error('Worker adapter creation timed out after 5s');
        }),
      ]);

      if (!E.isRight(workerResult)) {
        console.error('Failed to create worker adapter:', workerResult.left);
        throw new Error('Failed to create worker adapter');
      }
      workerAdapter = workerResult.right;
      worker = workerAdapter.worker;
      console.log('Worker adapter created successfully');

      // Start the worker with timeout
      console.log('Starting worker...');
      worker.on('ready', () => console.log('Worker is ready'));
      worker.on('error', (err) => console.error('Worker error:', err));
      worker.on('closing', () => console.log('Worker is closing'));
      worker.on('closed', () => console.log('Worker is closed'));

      const startPromise = workerAdapter.start()();
      const startResult = await Promise.race([
        startPromise,
        waitWithTimeout(15000).then(() => {
          throw new Error('Worker start timed out after 15s');
        }),
      ]);

      if (!E.isRight(startResult)) {
        console.error('Failed to start worker:', startResult.left);
        throw new Error('Failed to start worker');
      }
      console.log('Worker started successfully');
    } catch (error) {
      console.error('Setup failed:', error);
      // Log worker state if available
      if (worker) {
        console.log('Worker state:', {
          isRunning: workerAdapter.isRunning(),
        });
      }
      throw error;
    }
  }, 30000);

  afterAll(async () => {
    // Stop worker
    if (workerAdapter) {
      await workerAdapter.stop()();
    }

    // Clean up test queue
    if (queueAdapter) {
      await queueAdapter.cleanQueue()();
    }

    // Close connections
    if (queue) {
      await queue.close();
    }
    if (worker) {
      await worker.close();
    }

    // Wait for cleanup
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });

  beforeEach(async () => {
    // Reset processed jobs
    processedJobs = [];

    // Stop and close existing worker if running
    if (workerAdapter) {
      console.log('Stopping worker in beforeEach...');
      await workerAdapter.stop()();
      await waitWithTimeout(500); // Wait for worker to fully stop
      await worker.close();
      await waitWithTimeout(500); // Wait for worker to fully close
    }

    // Clean up any existing jobs
    if (queue) {
      console.log('Cleaning up jobs in beforeEach...');
      // Wait for any active jobs to complete
      await waitWithTimeout(1000);

      // Clean up jobs in parallel
      await Promise.all([
        queue.clean(0, 0, 'completed'),
        queue.clean(0, 0, 'failed'),
        queue.clean(0, 0, 'delayed'),
        queue.clean(0, 0, 'wait'),
        queue.clean(0, 0, 'active'),
        queue.clean(0, 0, 'paused'),
      ]);

      // Wait for cleanup to complete
      await waitWithTimeout(1000);

      // Obliterate queue after cleaning
      await queue.obliterate();
      console.log('Jobs cleaned up');
    }

    // Create new worker adapter for each test
    console.log('Creating new worker adapter...');
    const workerResult = await createWorkerAdapter(TEST_QUEUE, testProcessor)();
    if (!E.isRight(workerResult)) {
      throw new Error('Failed to create worker adapter');
    }
    workerAdapter = workerResult.right;
    worker = workerAdapter.worker;
    console.log('Worker adapter created');

    // Start worker and wait for it to be ready
    console.log('Starting worker in beforeEach...');
    const startResult = await workerAdapter.start()();
    if (!E.isRight(startResult)) {
      throw new Error('Failed to start worker');
    }
    await waitWithTimeout(500); // Wait for worker to be fully ready

    if (!workerAdapter.isRunning()) {
      throw new Error('Worker failed to start in beforeEach');
    }
    console.log('Worker started in beforeEach');
  });

  afterEach(async () => {
    // Stop worker first
    if (workerAdapter) {
      console.log('Stopping worker in afterEach...');
      await workerAdapter.stop()();
      await waitWithTimeout(500); // Wait for worker to fully stop
      await worker.close();
      await waitWithTimeout(500); // Wait for worker to fully close
    }

    // Clean up jobs
    if (queue) {
      console.log('Cleaning up jobs in afterEach...');
      // Wait for any active jobs to complete
      await waitWithTimeout(1000);

      // Clean up jobs in parallel
      await Promise.all([
        queue.clean(0, 0, 'completed'),
        queue.clean(0, 0, 'failed'),
        queue.clean(0, 0, 'delayed'),
        queue.clean(0, 0, 'wait'),
        queue.clean(0, 0, 'active'),
        queue.clean(0, 0, 'paused'),
      ]);

      // Wait for cleanup to complete
      await waitWithTimeout(1000);

      // Obliterate queue after cleaning
      await queue.obliterate();
      console.log('Jobs cleaned up');
    }
  });

  describe('Queue Operations', () => {
    it('should add and process a job', async () => {
      const jobData: TestJobData = {
        type: 'test-job',
        timestamp: new Date(),
        data: { value: 'test value' },
      };

      console.log('Adding job to queue...');
      const addResult = await queueAdapter.addJob(jobData)();
      if (!E.isRight(addResult)) {
        throw new Error('Failed to add job');
      }
      const jobId = addResult.right.id;
      if (!jobId) {
        throw new Error('Job ID is undefined');
      }
      console.log('Job added successfully:', jobId);

      // Wait for job to be processed
      await waitForJobProcessing();

      console.log('Processed jobs:', processedJobs);
      expect(processedJobs).toHaveLength(1);
      expect(processedJobs[0].type).toBe(jobData.type);
      expect(processedJobs[0].data).toEqual(jobData.data);
      expect(new Date(processedJobs[0].timestamp).getTime()).toBe(jobData.timestamp.getTime());

      // Verify job status in Redis
      const job = await waitForJobCompletion(queue, jobId);
      expect(job?.finishedOn).toBeDefined();
      expect(job?.processedOn).toBeDefined();
    });

    it('should remove a job', async () => {
      // Add job
      const jobData: TestJobData = {
        type: 'test-job',
        timestamp: new Date(),
        data: { value: 'test' },
      };

      console.log('Adding job...');
      const addResult = await queueAdapter.addJob(jobData)();
      if (!E.isRight(addResult)) {
        throw new Error('Failed to add job');
      }
      const jobId = addResult.right.id;
      if (!jobId) {
        throw new Error('Job ID is undefined');
      }
      console.log('Job added:', jobId);

      // Wait for job to be added
      let job = await queue.getJob(jobId);
      let attempts = 0;
      const maxAttempts = 10;
      while (!job && attempts < maxAttempts) {
        await waitWithTimeout(500);
        job = await queue.getJob(jobId);
        attempts++;
      }

      // Remove job
      console.log('Removing job:', jobId);
      const removeResult = await queueAdapter.removeJob(jobId)();
      if (!E.isRight(removeResult)) {
        throw new Error('Failed to remove job');
      }
      console.log('Job removal initiated');

      // Wait for job to be removed
      job = await waitForJobRemoval(queue, jobId);
      expect(job).toBeUndefined();
    });

    it('should pause and resume the queue', async () => {
      // Reset processed jobs
      processedJobs = [];

      // Pause queue
      console.log('Pausing queue...');
      const pauseResult = await queueAdapter.pauseQueue()();
      if (!E.isRight(pauseResult)) {
        throw new Error('Failed to pause queue');
      }
      console.log('Queue paused');

      // Wait for queue to pause
      await waitWithTimeout(1000);

      // Add job while paused
      const jobData: TestJobData = {
        type: 'test-job',
        timestamp: new Date(),
        data: { value: 'paused job' },
      };

      console.log('Adding job to paused queue...');
      const addResult = await queueAdapter.addJob(jobData)();
      if (!E.isRight(addResult)) {
        throw new Error('Failed to add job');
      }
      const jobId = addResult.right.id;
      if (!jobId) {
        throw new Error('Job ID is undefined');
      }
      console.log('Job added to paused queue:', jobId);

      // Wait to verify job is not processed while paused
      await waitWithTimeout(1000);
      console.log('Processed jobs while paused:', processedJobs);
      expect(processedJobs).toHaveLength(0); // Job should not be processed while paused

      // Resume queue
      console.log('Resuming queue...');
      const resumeResult = await queueAdapter.resumeQueue()();
      if (!E.isRight(resumeResult)) {
        throw new Error('Failed to resume queue');
      }
      console.log('Queue resumed');

      // Wait for job to be processed
      await waitForJobProcessing();

      console.log('Processed jobs after resume:', processedJobs);
      expect(processedJobs).toHaveLength(1); // Job should be processed after resume
      expect(processedJobs[0].data.value).toBe('paused job');

      // Verify job status in Redis
      const job = await waitForJobCompletion(queue, jobId);
      expect(job?.finishedOn).toBeDefined();
      expect(job?.processedOn).toBeDefined();
    });

    it('should clean old jobs', async () => {
      // Stop worker to prevent job processing
      console.log('Stopping worker...');
      await workerAdapter.stop()();
      console.log('Worker stopped');

      // Add old job
      const oldJobData: TestJobData = {
        type: 'test-job',
        timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days old
        data: { value: 'old job' },
      };

      console.log('Adding old job...');
      const addResult = await queueAdapter.addJob(oldJobData)();
      if (!E.isRight(addResult)) {
        throw new Error('Failed to add job');
      }
      const jobId = addResult.right.id;
      if (!jobId) {
        throw new Error('Job ID is undefined');
      }
      console.log('Old job added:', jobId);

      // Wait for job to be added
      let job = await queue.getJob(jobId);
      let attempts = 0;
      const maxAttempts = 10;
      while (!job && attempts < maxAttempts) {
        await waitWithTimeout(500);
        job = await queue.getJob(jobId);
        attempts++;
      }

      // Clean old jobs
      console.log('Cleaning old jobs...');
      const cleanResult = await queueAdapter.cleanQueue({ age: 1000 })();
      if (!E.isRight(cleanResult)) {
        throw new Error('Failed to clean jobs');
      }
      console.log('Jobs cleaned');

      // Wait for cleanup to complete
      attempts = 0;
      while (attempts < maxAttempts) {
        job = await queue.getJob(jobId);
        if (!job) {
          break;
        }
        await waitWithTimeout(500);
        attempts++;
      }

      // Verify job was cleaned
      job = await queue.getJob(jobId);
      expect(job).toBeUndefined();

      // Restart worker for other tests
      console.log('Restarting worker...');
      await workerAdapter.start()();
      console.log('Worker restarted');
    });
  });

  describe('Worker Operations', () => {
    it('should start and stop worker', async () => {
      // Stop worker
      await workerAdapter.stop()();
      await waitWithTimeout(500); // Wait for worker to fully stop
      expect(workerAdapter.isRunning()).toBe(false);

      // Add job while worker is stopped
      const jobData: TestJobData = {
        type: 'test-job',
        timestamp: new Date(),
        data: { value: 'worker test' },
      };

      const addResult = await queueAdapter.addJob(jobData)();
      if (!E.isRight(addResult)) {
        throw new Error('Failed to add job');
      }
      const jobId = addResult.right.id;
      if (!jobId) {
        throw new Error('Job ID is undefined');
      }

      // Wait for job to be added
      let job = await queue.getJob(jobId);
      let attempts = 0;
      const maxAttempts = 10;
      while (!job && attempts < maxAttempts) {
        await waitWithTimeout(500);
        job = await queue.getJob(jobId);
        attempts++;
      }

      // Verify job is not processed while worker is stopped
      expect(processedJobs).toHaveLength(0);

      // Start worker and wait for it to be ready
      await workerAdapter.start()();
      await waitWithTimeout(500); // Wait for worker to be fully ready
      expect(workerAdapter.isRunning()).toBe(true);

      // Wait for job to be processed
      attempts = 0;
      while ((!job?.finishedOn || !job?.processedOn) && attempts < maxAttempts) {
        await waitWithTimeout(500);
        job = await queue.getJob(jobId);
        attempts++;
      }

      expect(processedJobs).toHaveLength(1); // Job should be processed after worker starts
    });

    it('should handle job processing errors', async () => {
      // Create error worker
      const errorProcessor: JobProcessor<TestJobData> = (job) =>
        TE.tryCatch(
          async () => {
            console.log('Error processor throwing error');
            throw new Error('Intentional test error');
          },
          (error) => {
            console.log('Error processor caught error:', error);
            const queueError = createStandardQueueError({
              code: QueueErrorCode.PROCESSING_ERROR,
              message: error instanceof Error ? error.message : String(error),
              queueName: TEST_QUEUE,
              operation: QueueOperation.PROCESS_JOB,
              cause: error instanceof Error ? error : new Error(String(error)),
            });
            return queueError;
          },
        );

      const errorWorker = await createWorkerAdapter<TestJobData>(TEST_QUEUE, errorProcessor)();
      if (!E.isRight(errorWorker)) {
        throw new Error('Failed to create error worker');
      }

      // Stop default worker and start error worker
      await workerAdapter.stop()();
      await errorWorker.right.start()();

      // Add job that will fail
      const jobData: TestJobData = {
        type: 'test-job',
        timestamp: new Date(),
        data: { value: 'error test' },
      };

      const addResult = await queueAdapter.addJob(jobData)();
      if (!E.isRight(addResult)) {
        throw new Error('Failed to add job');
      }
      const jobId = addResult.right.id;
      if (!jobId) {
        throw new Error('Job ID is undefined');
      }

      // Wait for job to fail
      const job = await waitForJobFailure(queue, jobId);
      expect(job?.failedReason).toBe('Intentional test error');

      // Clean up error worker
      await errorWorker.right.stop()();
    });

    it('should properly process and complete a job', async () => {
      const jobData: TestJobData = {
        type: 'test-job',
        timestamp: new Date(),
        data: { value: 'completion test' },
      };

      const addResult = await queueAdapter.addJob(jobData)();
      if (!E.isRight(addResult)) {
        throw new Error('Failed to add job');
      }
      const jobId = addResult.right.id;
      if (!jobId) {
        throw new Error('Job ID is undefined');
      }

      // Wait for job to be processed
      let job = await queue.getJob(jobId);
      let attempts = 0;
      const maxAttempts = 10;
      while ((!job?.finishedOn || !job?.processedOn) && attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        job = await queue.getJob(jobId);
        attempts++;
      }

      // Verify job was processed
      expect(processedJobs).toHaveLength(1);
      expect(processedJobs[0].data.value).toBe('completion test');

      // Verify job status in Redis
      expect(job?.finishedOn).toBeDefined();
      expect(job?.processedOn).toBeDefined();
      expect(job?.failedReason).toBeUndefined();
    });

    it('should properly handle failed jobs', async () => {
      // Add job that will fail
      const jobData: TestJobData = {
        type: 'test-job',
        timestamp: new Date(),
        data: { value: 'error test' },
      };

      const addResult = await queueAdapter.addJob(jobData)();
      if (!E.isRight(addResult)) {
        throw new Error('Failed to add job');
      }
      const jobId = addResult.right.id;
      if (!jobId) {
        throw new Error('Job ID is undefined');
      }

      // Wait for job to fail
      const job = await waitForJobFailure(queue, jobId);
      expect(job?.failedReason).toBeDefined();
    });
  });
});
