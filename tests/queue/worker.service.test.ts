import { QueueService } from 'infrastructure/queue/types';
import { QueueConfig } from '../../src/config/queue/queue.config';
import { createQueueService } from '../../src/infrastructure/queue/core/queue.service';
import { createWorkerService } from '../../src/infrastructure/queue/core/worker.service';
import { QueueError, QueueErrorCode } from '../../src/types/errors.type';
import { JobData } from '../../src/types/job.type';

jest.setTimeout(10000); // Reduce timeout to 10 seconds since tests run in ~9 seconds

describe('Worker Service Tests', () => {
  const queueName = 'test-worker-queue';
  const config: QueueConfig = {
    producerConnection: {
      host: 'localhost',
      port: 6379,
    },
    consumerConnection: {
      host: 'localhost',
      port: 6379,
    },
  };

  let queueService: ReturnType<QueueService<JobData>['getQueue']> | undefined;

  // Setup before all tests
  beforeAll(async () => {
    const queueServiceResult = await createQueueService<JobData>(queueName, config)();
    expect(queueServiceResult._tag).toBe('Right');
    if (queueServiceResult._tag === 'Right') {
      queueService = queueServiceResult.right.getQueue();
    }
  });

  // Cleanup before each test
  beforeEach(async () => {
    if (queueService) {
      await queueService.obliterate({ force: true });
    }
  });

  // Cleanup after all tests
  afterAll(async () => {
    if (queueService) {
      await queueService.obliterate({ force: true });
      await queueService.disconnect();
    }
  });

  describe('Core Operations', () => {
    test('should create worker with configuration', async () => {
      const workerServiceResult = await createWorkerService<JobData>(
        queueName,
        config,
        async () => {
          // Empty processor
        },
      )();

      expect(workerServiceResult._tag).toBe('Right');
      if (workerServiceResult._tag === 'Right') {
        const workerService = workerServiceResult.right;
        const worker = workerService.getWorker();

        expect(worker).toBeDefined();
        expect(worker.isRunning()).toBe(true);

        // Close worker and wait for it to be closed
        await new Promise<void>((resolve) => {
          worker.once('closed', resolve);
          workerService.close()();
        });
      }
    });

    test('should set concurrency settings', async () => {
      const workerServiceResult = await createWorkerService<JobData>(
        queueName,
        config,
        async () => {
          // Empty processor
        },
        { concurrency: 2 },
      )();

      expect(workerServiceResult._tag).toBe('Right');
      if (workerServiceResult._tag === 'Right') {
        const workerService = workerServiceResult.right;
        const worker = workerService.getWorker();

        expect(worker.opts.concurrency).toBe(2);

        workerService.setConcurrency(3);
        expect(worker.opts.concurrency).toBe(3);

        // Close worker and wait for it to be closed
        await new Promise<void>((resolve) => {
          worker.once('closed', resolve);
          workerService.close()();
        });
      }
    });

    test('should pause and resume worker', async () => {
      const workerServiceResult = await createWorkerService<JobData>(
        queueName,
        config,
        async () => {
          // Empty processor
        },
      )();

      expect(workerServiceResult._tag).toBe('Right');
      if (workerServiceResult._tag === 'Right') {
        const workerService = workerServiceResult.right;
        const worker = workerService.getWorker();

        const pauseResult = await workerService.pause()();
        expect(pauseResult._tag).toBe('Right');
        expect(worker.isPaused()).toBe(true);

        const resumeResult = await workerService.resume()();
        expect(resumeResult._tag).toBe('Right');
        expect(worker.isPaused()).toBe(false);

        // Close worker and wait for it to be closed
        await new Promise<void>((resolve) => {
          worker.once('closed', resolve);
          workerService.close()();
        });
      }
    });
  });

  describe('Advanced Features', () => {
    test('should handle worker events', async () => {
      const events: string[] = [];

      // Create worker first
      const workerServiceResult = await createWorkerService<JobData>(
        queueName,
        config,
        async () => {
          events.push('processing');
        },
      )();

      expect(workerServiceResult._tag).toBe('Right');
      if (workerServiceResult._tag === 'Right') {
        const workerService = workerServiceResult.right;
        const worker = workerService.getWorker();

        // Worker should already be ready at this point
        events.push('ready');

        // Close worker and wait for events
        await new Promise<void>((resolve) => {
          worker.once('closing', () => events.push('closing'));
          worker.once('closed', () => {
            events.push('closed');
            resolve();
          });
          workerService.close()();
        });

        // Verify events and their order
        expect(events).toContain('ready');
        expect(events).toContain('closing');
        expect(events).toContain('closed');
        expect(events.indexOf('ready')).toBeLessThan(events.indexOf('closing'));
        expect(events.indexOf('closing')).toBeLessThan(events.indexOf('closed'));
      }
    });

    test('should handle worker lifecycle', async () => {
      const workerServiceResult = await createWorkerService<JobData>(
        queueName,
        config,
        async () => {
          // Empty processor
        },
      )();

      expect(workerServiceResult._tag).toBe('Right');
      if (workerServiceResult._tag === 'Right') {
        const workerService = workerServiceResult.right;
        const worker = workerService.getWorker();

        // Test worker status
        expect(worker.isRunning()).toBe(true);

        // Test pause
        await workerService.pause()();
        expect(worker.isPaused()).toBe(true);

        // Test resume
        await workerService.resume()();
        expect(worker.isPaused()).toBe(false);

        // Test close with proper waiting for all events
        await new Promise<void>((resolve) => {
          worker.once('closed', () => {
            // Give a small delay for internal cleanup
            setTimeout(resolve, 100);
          });
          workerService.close()();
        });

        // Now check the running state
        expect(worker.isRunning()).toBe(false);
      }
    });

    test('should handle worker options', async () => {
      const workerServiceResult = await createWorkerService<JobData>(
        queueName,
        config,
        async () => {
          // Empty processor
        },
        {
          concurrency: 5,
        },
      )();

      expect(workerServiceResult._tag).toBe('Right');
      if (workerServiceResult._tag === 'Right') {
        const workerService = workerServiceResult.right;
        const worker = workerService.getWorker();

        // Test initial options
        expect(worker.opts.concurrency).toBe(5);

        // Test dynamic concurrency change
        workerService.setConcurrency(3);
        expect(worker.opts.concurrency).toBe(3);

        // Test pause with force option
        await workerService.pause(true)();
        expect(worker.isPaused()).toBe(true);

        // Close worker and wait for it to be closed
        await new Promise<void>((resolve) => {
          worker.once('closed', resolve);
          workerService.close()();
        });
      }
    });

    test('should handle worker error events', async () => {
      // Create the worker first
      const workerServiceResult = await createWorkerService<JobData>(
        queueName,
        config,
        async () => {
          throw new Error('Test error');
        },
        {
          // Set minimal stalled interval to speed up error handling
          stalledInterval: 100,
          maxStalledCount: 1,
        },
      )();

      expect(workerServiceResult._tag).toBe('Right');
      if (workerServiceResult._tag === 'Right') {
        const workerService = workerServiceResult.right;
        const worker = workerService.getWorker();

        try {
          // Setup error promise before adding job
          const errorPromise = new Promise<QueueError>((resolve) => {
            worker.on('failed', (job, error: Error) => {
              // The worker service wraps the error in a QueueError
              // We need to cast through unknown first since Error and QueueError don't overlap
              const queueError = error as unknown as QueueError;
              resolve(queueError);
            });
          });

          // Ensure worker is ready and running
          expect(worker.isRunning()).toBe(true);

          // Add job to trigger error and wait for it to be added
          const job = await queueService?.add('test', {
            type: 'META',
            timestamp: new Date(),
            data: {},
          });
          expect(job).toBeDefined();

          // Wait for job to become active
          await new Promise<void>((resolve) => {
            worker.once('active', () => resolve());
          });

          // Wait for error with a reasonable timeout
          const error = await Promise.race([
            errorPromise,
            new Promise<QueueError>((_, reject) =>
              setTimeout(() => reject(new Error('Timeout waiting for error event')), 1000),
            ),
          ]);

          expect(error.code).toBe(QueueErrorCode.PROCESSING_ERROR);
          expect(error.error.message).toBe('Test error');
        } finally {
          // Close worker and wait for it to be closed
          await new Promise<void>((resolve) => {
            worker.once('closed', resolve);
            workerService.close()();
          });
        }
      }
    });
  });
});
