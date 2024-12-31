import { Job, Queue } from 'bullmq';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { createQueueAdapter, createWorkerAdapter } from '../../src/infrastructures/queue';
import { MetaJobType } from '../../src/queues/jobs/core/meta.job';
import { QueueErrorCode } from '../../src/types/errors.type';
import {
  BaseJobData,
  JobOperationType,
  JobProcessor,
  JobType,
  QueueAdapter,
  WorkerAdapter,
} from '../../src/types/queue.type';
import { QueueOperation } from '../../src/types/shared.type';
import { createStandardQueueError } from '../../src/utils/queue.utils';

interface TestJobData extends BaseJobData {
  type: JobType.META;
  timestamp: Date;
  data: {
    value: string;
    type: MetaJobType;
    operation: JobOperationType;
  };
}

const TEST_QUEUE = 'test_queue';

describe('Queue Infrastructure Tests', () => {
  let queue: Queue;
  let queueAdapter: QueueAdapter;
  let workerAdapter: WorkerAdapter<TestJobData>;
  let processedJobs: Array<TestJobData> = [];

  const waitWithTimeout = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const waitForJobFailure = async (queue: Queue, jobId: string) => {
    let job = await queue.getJob(jobId);
    let attempts = 0;
    const maxAttempts = 10;
    while ((!job?.failedReason || !job?.finishedOn) && attempts < maxAttempts) {
      await waitWithTimeout(1000);
      job = await queue.getJob(jobId);
      attempts++;
    }
    return job;
  };

  const defaultProcessor: JobProcessor<TestJobData> = (job: Job<TestJobData>) =>
    TE.tryCatch(
      async () => {
        console.log('Processing job:', job.id);
        processedJobs.push(job.data);
      },
      (error) => {
        console.error('Error processing job:', error);
        return createStandardQueueError({
          code: QueueErrorCode.PROCESSING_ERROR,
          message: error instanceof Error ? error.message : String(error),
          queueName: TEST_QUEUE,
          operation: QueueOperation.PROCESS_JOB,
          cause: error instanceof Error ? error : new Error(String(error)),
        });
      },
    );

  beforeAll(async () => {
    console.log('Setting up test environment...');
    // Create queue and worker for tests
    const queueResult = await createQueueAdapter(TEST_QUEUE)();
    expect(E.isRight(queueResult)).toBe(true);
    if (E.isRight(queueResult)) {
      queueAdapter = queueResult.right;
      queue = queueAdapter.queue;
    }

    const workerResult = await createWorkerAdapter(TEST_QUEUE, defaultProcessor)();
    expect(E.isRight(workerResult)).toBe(true);
    if (E.isRight(workerResult)) {
      workerAdapter = workerResult.right;
    }
  }, 60000);

  afterAll(async () => {
    console.log('Stopping worker in afterAll...');
    try {
      await workerAdapter.stop()();
    } catch (error) {
      console.error('Error stopping worker in afterAll:', error);
    }

    console.log('Cleaning up queue in afterAll...');
    try {
      await queueAdapter.cleanQueue()();
    } catch (error) {
      console.error('Error cleaning queue in afterAll:', error);
    }

    console.log('Closing queue connection...');
    try {
      await queue.close();
    } catch (error) {
      console.error('Error closing queue in afterAll:', error);
    }

    console.log('Closing worker connection...');
    try {
      await workerAdapter.worker.close();
    } catch (error) {
      console.error('Error closing worker in afterAll:', error);
    }

    console.log('All connections closed in afterAll');
  }, 60000);

  beforeEach(async () => {
    console.log('Stopping worker in beforeEach...');
    try {
      // If worker is in error state, reset it first
      if (workerAdapter.worker.isRunning()) {
        await workerAdapter.stop()();
        await waitWithTimeout(2000);
      }

      // Create new worker adapter to ensure clean state
      console.log('Creating new worker adapter...');
      const workerResult = await createWorkerAdapter<TestJobData>(TEST_QUEUE, defaultProcessor)();
      if (!E.isRight(workerResult)) {
        throw new Error('Failed to create worker adapter');
      }
      workerAdapter = workerResult.right as WorkerAdapter<TestJobData>;

      // Clean up any existing jobs
      console.log('Cleaning up jobs in beforeEach...');
      await queueAdapter.cleanQueue()();
      await waitWithTimeout(2000);

      processedJobs = [];

      console.log('Starting worker in beforeEach...');
      const startResult = await workerAdapter.start()();
      if (!E.isRight(startResult)) {
        throw new Error('Failed to start worker');
      }
      await waitWithTimeout(2000);

      // Verify worker is running
      if (!workerAdapter.isRunning()) {
        throw new Error('Worker failed to start properly');
      }
      console.log('Worker started in beforeEach');
    } catch (error) {
      console.error('Error in beforeEach:', error);
      throw error;
    }
  }, 60000);

  afterEach(async () => {
    console.log('Stopping worker in afterEach...');
    try {
      // If worker is running, stop it
      if (workerAdapter.worker.isRunning()) {
        await workerAdapter.stop()();
        await waitWithTimeout(2000);
      }

      // Clean up jobs regardless of worker state
      console.log('Cleaning up jobs in afterEach...');
      await queueAdapter.cleanQueue()();
      await waitWithTimeout(2000);

      processedJobs = [];
    } catch (error) {
      console.error('Error in afterEach:', error);
      throw error;
    }
  }, 60000);

  describe('Queue Operations', () => {
    it('should add and process jobs successfully', async () => {
      const jobData: TestJobData = {
        type: JobType.META,
        timestamp: new Date(),
        data: {
          value: 'test value',
          type: MetaJobType.EVENTS,
          operation: JobOperationType.CREATE,
        },
      };

      // Add job
      const addResult = await queueAdapter.addJob(jobData)();
      expect(E.isRight(addResult)).toBe(true);
      if (E.isLeft(addResult)) return;

      const jobId = addResult.right.id;
      expect(jobId).toBeDefined();

      // Wait for job to be processed
      await waitWithTimeout(5000);

      // Verify job was processed
      expect(processedJobs.length).toBe(1);
      expect(processedJobs[0].data.value).toBe('test value');
    }, 60000);

    it('should handle multiple jobs in sequence', async () => {
      const jobs = Array.from({ length: 3 }, (_, i) => ({
        type: JobType.META,
        timestamp: new Date(),
        data: {
          value: `test value ${i}`,
          type: MetaJobType.EVENTS,
          operation: JobOperationType.CREATE,
        },
      }));

      // Add jobs
      const results = await Promise.all(jobs.map((job) => queueAdapter.addJob(job)()));

      // Verify all jobs were added successfully
      results.forEach((result) => {
        expect(E.isRight(result)).toBe(true);
      });

      // Wait for jobs to be processed
      await waitWithTimeout(10000);

      // Verify all jobs were processed in order
      expect(processedJobs.length).toBe(3);
      processedJobs.forEach((job, i) => {
        expect(job.data.value).toBe(`test value ${i}`);
      });
    }, 60000);

    it('should clean up jobs correctly', async () => {
      // Add some jobs
      const jobs = Array.from({ length: 3 }, (_, i) => ({
        type: JobType.META,
        timestamp: new Date(),
        data: {
          value: `cleanup test ${i}`,
          type: MetaJobType.EVENTS,
          operation: JobOperationType.CREATE,
        },
      }));

      await Promise.all(jobs.map((job) => queueAdapter.addJob(job)()));

      // Wait for jobs to be processed
      await waitWithTimeout(5000);

      // Clean up queue
      const cleanupResult = await queueAdapter.cleanQueue()();
      expect(E.isRight(cleanupResult)).toBe(true);

      // Verify queue is empty
      const jobCounts = await queue.getJobCounts();
      expect(jobCounts.completed).toBe(0);
      expect(jobCounts.failed).toBe(0);
      expect(jobCounts.delayed).toBe(0);
      expect(jobCounts.active).toBe(0);
      expect(jobCounts.waiting).toBe(0);
    }, 60000);
  });

  describe('Worker Operations', () => {
    it('should start and stop worker', async () => {
      // Stop worker and wait for it to be fully stopped
      const initialStopResult = await workerAdapter.stop()();
      expect(E.isRight(initialStopResult)).toBe(true);
      await waitWithTimeout(5000);
      expect(workerAdapter.isRunning()).toBe(false);

      // Start worker and wait for it to be fully started
      const startResult = await workerAdapter.start()();
      expect(E.isRight(startResult)).toBe(true);
      await waitWithTimeout(5000);
      expect(workerAdapter.isRunning()).toBe(true);

      // Stop worker and wait for it to be fully stopped
      const stopResult = await workerAdapter.stop()();
      expect(E.isRight(stopResult)).toBe(true);
      await waitWithTimeout(5000);
      expect(workerAdapter.isRunning()).toBe(false);
    }, 120000);

    it('should handle job processing errors', async () => {
      // Create error worker
      const errorProcessor: JobProcessor<TestJobData> = (job: Job<TestJobData>) =>
        TE.tryCatch(
          async () => {
            console.log('Error processor throwing error for job:', job.id);
            throw new Error(`Intentional test error for job ${job.id}`);
          },
          (error) => {
            console.log('Error processor caught error:', error);
            return createStandardQueueError({
              code: QueueErrorCode.PROCESSING_ERROR,
              message: error instanceof Error ? error.message : String(error),
              queueName: TEST_QUEUE,
              operation: QueueOperation.PROCESS_JOB,
              cause: error instanceof Error ? error : new Error(String(error)),
            });
          },
        );

      // Stop default worker and wait for it to be fully stopped
      const stopResult = await workerAdapter.stop()();
      expect(E.isRight(stopResult)).toBe(true);
      await waitWithTimeout(5000);
      expect(workerAdapter.isRunning()).toBe(false);

      // Create and start error worker
      const errorWorkerResult = await createWorkerAdapter<TestJobData>(
        TEST_QUEUE,
        errorProcessor,
      )();
      expect(E.isRight(errorWorkerResult)).toBe(true);
      if (E.isLeft(errorWorkerResult)) {
        throw new Error('Failed to create error worker');
      }
      const errorWorker = errorWorkerResult.right;

      const startResult = await errorWorker.start()();
      expect(E.isRight(startResult)).toBe(true);
      await waitWithTimeout(5000);
      expect(errorWorker.isRunning()).toBe(true);

      // Add job that will fail
      const jobData: TestJobData = {
        type: JobType.META,
        timestamp: new Date(),
        data: {
          value: 'error test',
          type: MetaJobType.EVENTS,
          operation: JobOperationType.CREATE,
        },
      };

      const addResult = await queueAdapter.addJob(jobData)();
      expect(E.isRight(addResult)).toBe(true);
      if (E.isLeft(addResult)) {
        throw new Error('Failed to add job');
      }
      const jobId = addResult.right.id;
      if (!jobId) {
        throw new Error('Job ID is undefined');
      }

      // Wait for job to fail
      const job = await waitForJobFailure(queue, jobId);
      expect(job?.failedReason).toBe(`Intentional test error for job ${jobId}`);

      // Clean up error worker
      const cleanupResult = await errorWorker.stop()();
      expect(E.isRight(cleanupResult)).toBe(true);
      await waitWithTimeout(5000);
      expect(errorWorker.isRunning()).toBe(false);
    }, 120000);

    it('should handle worker restart with pending jobs', async () => {
      // Add a job
      const jobData: TestJobData = {
        type: JobType.META,
        timestamp: new Date(),
        data: {
          value: 'restart test',
          type: MetaJobType.EVENTS,
          operation: JobOperationType.CREATE,
        },
      };

      const addResult = await queueAdapter.addJob(jobData)();
      expect(E.isRight(addResult)).toBe(true);
      if (E.isLeft(addResult)) {
        throw new Error('Failed to add job');
      }
      const jobId = addResult.right.id;
      expect(jobId).toBeDefined();

      // Stop worker and wait for it to be fully stopped
      const stopResult = await workerAdapter.stop()();
      expect(E.isRight(stopResult)).toBe(true);
      await waitWithTimeout(5000);
      expect(workerAdapter.isRunning()).toBe(false);

      // Start worker again and wait for it to be fully started
      const startResult = await workerAdapter.start()();
      expect(E.isRight(startResult)).toBe(true);
      await waitWithTimeout(5000);
      expect(workerAdapter.isRunning()).toBe(true);

      // Wait for job to be processed
      await waitWithTimeout(5000);

      // Verify job was processed after restart
      expect(processedJobs.length).toBe(1);
      expect(processedJobs[0].data.value).toBe('restart test');
    }, 120000);

    it('should handle concurrent job processing correctly', async () => {
      // Create worker with concurrency 2
      await workerAdapter.stop()();
      const concurrentWorkerResult = await createWorkerAdapter<TestJobData>(
        TEST_QUEUE,
        defaultProcessor,
      )();
      expect(E.isRight(concurrentWorkerResult)).toBe(true);
      if (E.isLeft(concurrentWorkerResult)) return;

      const concurrentWorker = concurrentWorkerResult.right;
      await concurrentWorker.start()();
      await waitWithTimeout(2000);

      // Add multiple jobs
      const jobs = Array.from({ length: 4 }, (_, i) => ({
        type: JobType.META,
        timestamp: new Date(),
        data: {
          value: `concurrent test ${i}`,
          type: MetaJobType.EVENTS,
          operation: JobOperationType.CREATE,
        },
      }));

      await Promise.all(jobs.map((job) => queueAdapter.addJob(job)()));

      // Wait for all jobs to be processed
      await waitWithTimeout(10000);

      // Verify all jobs were processed
      expect(processedJobs.length).toBe(4);
      expect(new Set(processedJobs.map((job) => job.data.value)).size).toBe(4);

      // Cleanup
      await concurrentWorker.stop()();
      await waitWithTimeout(2000);
    }, 120000);

    it('should handle worker state transitions correctly', async () => {
      // Ensure worker is in a known state
      if (workerAdapter.worker.isRunning()) {
        const initialStopResult = await workerAdapter.stop()();
        expect(E.isRight(initialStopResult)).toBe(true);
        await waitWithTimeout(2000);
      }

      // Create new worker to ensure clean state
      const workerResult = await createWorkerAdapter<TestJobData>(TEST_QUEUE, defaultProcessor)();
      expect(E.isRight(workerResult)).toBe(true);
      if (E.isLeft(workerResult)) return;
      const testWorker = workerResult.right;

      try {
        // Start worker and verify state
        const startResult = await testWorker.start()();
        expect(E.isRight(startResult)).toBe(true);
        await waitWithTimeout(2000);
        expect(testWorker.isRunning()).toBe(true);

        // Add a job to verify worker processes it in running state
        const jobData: TestJobData = {
          type: JobType.META,
          timestamp: new Date(),
          data: {
            value: 'state transition test',
            type: MetaJobType.EVENTS,
            operation: JobOperationType.CREATE,
          },
        };

        const addResult = await queueAdapter.addJob(jobData)();
        expect(E.isRight(addResult)).toBe(true);
        await waitWithTimeout(2000);

        // Verify job was processed
        expect(processedJobs.length).toBe(1);
        expect(processedJobs[0].data.value).toBe('state transition test');

        // Stop worker and verify state
        const stopResult = await testWorker.stop()();
        expect(E.isRight(stopResult)).toBe(true);
        await waitWithTimeout(2000);
        expect(testWorker.isRunning()).toBe(false);
      } finally {
        // Cleanup
        if (testWorker.isRunning()) {
          await testWorker.stop()();
          await waitWithTimeout(2000);
        }
      }
    }, 120000);

    it('should handle rapid start/stop transitions', async () => {
      // Create new worker for this test
      const workerResult = await createWorkerAdapter<TestJobData>(TEST_QUEUE, defaultProcessor)();
      expect(E.isRight(workerResult)).toBe(true);
      if (E.isLeft(workerResult)) return;
      const testWorker = workerResult.right;

      try {
        // Attempt rapid start/stop cycles
        for (let i = 0; i < 3; i++) {
          console.log(`Starting rapid cycle ${i + 1}`);

          const startResult = await testWorker.start()();
          expect(E.isRight(startResult)).toBe(true);
          await waitWithTimeout(2000);
          expect(testWorker.isRunning()).toBe(true);

          const stopResult = await testWorker.stop()();
          expect(E.isRight(stopResult)).toBe(true);
          await waitWithTimeout(2000);
          expect(testWorker.isRunning()).toBe(false);
        }
      } finally {
        // Cleanup
        if (testWorker.isRunning()) {
          await testWorker.stop()();
          await waitWithTimeout(2000);
        }
      }
    }, 120000);

    it('should handle worker restart during job processing', async () => {
      // Create new worker for this test
      const workerResult = await createWorkerAdapter<TestJobData>(TEST_QUEUE, defaultProcessor)();
      expect(E.isRight(workerResult)).toBe(true);
      if (E.isLeft(workerResult)) return;
      const testWorker = workerResult.right;

      try {
        // Start worker
        const startResult = await testWorker.start()();
        expect(E.isRight(startResult)).toBe(true);
        await waitWithTimeout(2000);
        expect(testWorker.isRunning()).toBe(true);

        // Add multiple jobs
        const jobs = Array.from({ length: 5 }, (_, i) => ({
          type: JobType.META,
          timestamp: new Date(),
          data: {
            value: `restart test ${i}`,
            type: MetaJobType.EVENTS,
            operation: JobOperationType.CREATE,
          },
        }));

        // Add jobs sequentially
        for (const jobData of jobs) {
          const addResult = await queueAdapter.addJob(jobData)();
          expect(E.isRight(addResult)).toBe(true);
          await waitWithTimeout(500); // Small delay between jobs
        }

        // Wait for some jobs to start processing
        await waitWithTimeout(2000);

        // Stop worker
        const stopResult = await testWorker.stop()();
        expect(E.isRight(stopResult)).toBe(true);
        await waitWithTimeout(2000);
        expect(testWorker.isRunning()).toBe(false);

        // Start worker again
        const restartResult = await testWorker.start()();
        expect(E.isRight(restartResult)).toBe(true);
        await waitWithTimeout(2000);
        expect(testWorker.isRunning()).toBe(true);

        // Wait for remaining jobs to be processed
        await waitWithTimeout(5000);

        // Verify all jobs were eventually processed
        expect(processedJobs.length).toBe(5);
        const processedValues = processedJobs.map((job) => job.data.value);
        jobs.forEach((job, i) => {
          expect(processedValues).toContain(`restart test ${i}`);
        });
      } finally {
        // Cleanup
        if (testWorker.isRunning()) {
          await testWorker.stop()();
          await waitWithTimeout(2000);
        }
      }
    }, 120000);

    it('should handle worker error recovery', async () => {
      // Create error-throwing processor
      const errorProcessor: JobProcessor<TestJobData> = (job: Job<TestJobData>) =>
        TE.tryCatch(
          async () => {
            if (job.data.data.value.includes('error')) {
              throw new Error('Intentional processor error');
            }
            processedJobs.push(job.data);
          },
          (error) => {
            console.error('Error processing job:', error);
            return createStandardQueueError({
              code: QueueErrorCode.PROCESSING_ERROR,
              message: error instanceof Error ? error.message : String(error),
              queueName: TEST_QUEUE,
              operation: QueueOperation.PROCESS_JOB,
              cause: error instanceof Error ? error : new Error(String(error)),
            });
          },
        );

      // Create new worker with error processor
      const errorWorkerResult = await createWorkerAdapter<TestJobData>(
        TEST_QUEUE,
        errorProcessor,
      )();
      expect(E.isRight(errorWorkerResult)).toBe(true);
      if (E.isLeft(errorWorkerResult)) return;

      const errorWorker = errorWorkerResult.right;
      try {
        // Start error worker
        await errorWorker.start()();
        await waitWithTimeout(2000);
        expect(errorWorker.isRunning()).toBe(true);

        // Add a mix of error-triggering and normal jobs
        const jobs = [
          {
            type: JobType.META,
            timestamp: new Date(),
            data: {
              value: 'error_job',
              type: MetaJobType.EVENTS,
              operation: JobOperationType.CREATE,
            },
          },
          {
            type: JobType.META,
            timestamp: new Date(),
            data: {
              value: 'normal_job',
              type: MetaJobType.EVENTS,
              operation: JobOperationType.CREATE,
            },
          },
        ];

        // Add jobs sequentially
        for (const jobData of jobs) {
          const addResult = await queueAdapter.addJob(jobData)();
          expect(E.isRight(addResult)).toBe(true);
          await waitWithTimeout(500); // Small delay between jobs
        }

        // Wait for jobs to be processed
        await waitWithTimeout(5000);

        // Verify error job failed but normal job was processed
        expect(processedJobs.length).toBe(1);
        expect(processedJobs[0].data.value).toBe('normal_job');
      } finally {
        // Cleanup
        if (errorWorker.isRunning()) {
          await errorWorker.stop()();
          await waitWithTimeout(2000);
        }
      }
    }, 120000);
  });
});
