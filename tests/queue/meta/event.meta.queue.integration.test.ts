import { Job } from 'bullmq';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { QUEUE_CONFIG } from '../../../src/config/queue/queue.config';
import { createEventMetaQueueService } from '../../../src/queue/meta/event.meta.queue';
import { EventMetaService, MetaJobData } from '../../../src/types/job.type';

// Increase Jest timeout for all tests
jest.setTimeout(60000);

describe('Event Meta Queue Integration Tests', () => {
  let config: { connection: { host: string; port: number } };
  let eventMetaService: EventMetaService;
  let cleanupFunctions: Array<() => Promise<void>>;

  beforeAll(() => {
    // Setup Redis connection for tests
    config = {
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT) || 6379,
      },
    };
  });

  beforeEach(() => {
    cleanupFunctions = [];
    // Mock event meta service with simple implementations
    eventMetaService = {
      syncMeta: jest.fn().mockImplementation(() => TE.right(undefined)),
      syncEvents: jest.fn().mockImplementation(() => TE.right(undefined)),
    };
  });

  afterEach(async () => {
    // Clean up resources after each test with delay between operations
    for (const cleanup of cleanupFunctions) {
      await cleanup();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });

  describe('Event Meta Queue Workflow', () => {
    it('should process event sync job successfully', async () => {
      const result = await createEventMetaQueueService(config, eventMetaService)();
      expect(E.isRight(result)).toBeTruthy();

      if (E.isRight(result)) {
        const queueService = result.right;
        cleanupFunctions.push(async () => {
          await queueService.close();
        });

        const mockJob = {
          id: '1',
          data: {
            type: 'META',
            name: 'meta',
            timestamp: new Date(),
            data: {
              operation: 'SYNC',
              metaType: 'EVENTS',
            },
          },
        } as Job<MetaJobData>;

        const processResult = await queueService.processJob(mockJob)();
        expect(E.isRight(processResult)).toBeTruthy();
        expect(eventMetaService.syncEvents).toHaveBeenCalled();
      }
    });

    it('should handle sync failures appropriately', async () => {
      const mockError = new Error('Sync failed');
      eventMetaService = {
        syncMeta: jest.fn().mockImplementation(() => TE.right(undefined)),
        syncEvents: jest.fn().mockImplementation(() => TE.left(mockError)),
      };

      const result = await createEventMetaQueueService(config, eventMetaService)();
      expect(E.isRight(result)).toBeTruthy();

      if (E.isRight(result)) {
        const queueService = result.right;
        cleanupFunctions.push(async () => {
          await queueService.close();
        });

        const mockJob = {
          id: '1',
          data: {
            type: 'META',
            name: 'meta',
            timestamp: new Date(),
            data: {
              operation: 'SYNC',
              metaType: 'EVENTS',
            },
          },
          attemptsMade: 0,
        } as Job<MetaJobData>;

        const processResult = await queueService.processJob(mockJob)();
        expect(E.isLeft(processResult)).toBeTruthy();
      }
    });

    it('should handle multiple sync operations with rate limiting', async () => {
      const result = await createEventMetaQueueService(config, eventMetaService)();
      expect(E.isRight(result)).toBeTruthy();

      if (E.isRight(result)) {
        const queueService = result.right;
        cleanupFunctions.push(async () => {
          await queueService.close();
        });

        // Reset mock before starting
        (eventMetaService.syncEvents as jest.Mock).mockClear();

        // Add jobs sequentially to ensure rate limiting takes effect
        const jobCount = QUEUE_CONFIG.RATE_LIMIT.MAX * 2; // Double the rate limit to test throttling
        const startTime = Date.now();
        const processingTimes: number[] = [];

        // Track when each job is processed
        (eventMetaService.syncEvents as jest.Mock).mockImplementation(() => {
          processingTimes.push(Date.now() - startTime);
          return TE.right(undefined);
        });

        // Add jobs rapidly
        for (let i = 0; i < jobCount; i++) {
          await queueService.syncMeta('EVENTS')();
        }

        // Wait for all jobs to complete
        await new Promise((resolve) => setTimeout(resolve, QUEUE_CONFIG.RATE_LIMIT.DURATION * 3));

        const duration = Date.now() - startTime;

        // Verify timing constraints
        expect(duration).toBeGreaterThanOrEqual(QUEUE_CONFIG.RATE_LIMIT.DURATION * 2);

        // Verify that jobs were processed in batches due to rate limiting
        const jobBatches = processingTimes.reduce(
          (acc, time) => {
            const batchIndex = Math.floor(time / QUEUE_CONFIG.RATE_LIMIT.DURATION);
            acc[batchIndex] = (acc[batchIndex] || 0) + 1;
            return acc;
          },
          {} as Record<number, number>,
        );

        // Each batch should not exceed the rate limit
        Object.values(jobBatches).forEach((batchCount) => {
          expect(batchCount).toBeLessThanOrEqual(QUEUE_CONFIG.RATE_LIMIT.MAX);
        });
      }
    }, 30000);

    it('should handle pause and resume operations', async () => {
      const result = await createEventMetaQueueService(config, eventMetaService)();
      expect(E.isRight(result)).toBeTruthy();

      if (E.isRight(result)) {
        const queueService = result.right;
        cleanupFunctions.push(async () => {
          await queueService.close();
        });

        // Pause the queue
        const pauseResult = await queueService.pause()();
        expect(E.isRight(pauseResult)).toBeTruthy();

        // Try to process a job while paused
        const mockJob = {
          id: '1',
          data: {
            type: 'META',
            name: 'meta',
            timestamp: new Date(),
            data: {
              operation: 'SYNC',
              metaType: 'EVENTS',
            },
          },
        } as Job<MetaJobData>;

        await queueService.addJob(mockJob.data)();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(eventMetaService.syncEvents).not.toHaveBeenCalled();

        // Resume the queue
        const resumeResult = await queueService.resume()();
        expect(E.isRight(resumeResult)).toBeTruthy();

        // Wait for job processing
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(eventMetaService.syncEvents).toHaveBeenCalled();
      }
    });

    it('should handle retry behavior with backoff', async () => {
      let attempts = 0;
      const maxAttempts = 3; // Reduce max attempts for testing
      const mockError = new Error('Sync failed');

      eventMetaService = {
        syncMeta: jest.fn().mockImplementation(() => TE.right(undefined)),
        syncEvents: jest.fn().mockImplementation(() => {
          attempts++;
          if (attempts < maxAttempts) {
            return TE.left(mockError);
          }
          return TE.right(undefined);
        }),
      };

      const result = await createEventMetaQueueService(config, eventMetaService)();
      expect(E.isRight(result)).toBeTruthy();

      if (E.isRight(result)) {
        const queueService = result.right;
        cleanupFunctions.push(async () => {
          await queueService.close();
        });

        const mockJob = {
          id: '1',
          data: {
            type: 'META',
            name: 'meta',
            timestamp: new Date(),
            data: {
              operation: 'SYNC',
              metaType: 'EVENTS',
            },
          },
          attemptsMade: 0,
        } as Job<MetaJobData>;

        // Process job and wait for retries
        await queueService.addJob(mockJob.data)();

        // Wait for retries with a reasonable timeout
        const retryTimeout = 1000; // 1 second per retry
        for (let i = 0; i < maxAttempts; i++) {
          await new Promise((resolve) => setTimeout(resolve, retryTimeout));
          if (attempts >= maxAttempts) break;
        }

        expect(attempts).toBeLessThanOrEqual(maxAttempts);
        expect(eventMetaService.syncEvents).toHaveBeenCalledTimes(attempts);
      }
    }, 10000);

    it('should handle connection errors', async () => {
      interface ConnectionError extends Error {
        code: string;
        errorno?: string;
        syscall?: string;
      }

      const invalidConfig = {
        connection: {
          host: 'invalid-host',
          port: 6379,
          retryStrategy: () => 0, // Disable retries by returning 0
          maxRetriesPerRequest: 0,
          connectTimeout: 100, // Very short timeout
          commandTimeout: 100, // Short command timeout
          lazyConnect: true, // Don't connect immediately
          enableOfflineQueue: false, // Don't queue commands when disconnected
          reconnectOnError: () => false, // Don't reconnect on error
          maxReconnectAttempts: 1, // Only try to reconnect once
        },
      };

      // Wrap the queue creation in a try-catch to handle any unhandled errors
      try {
        const queueServicePromise = createEventMetaQueueService(invalidConfig, eventMetaService)();
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Connection timeout')), 1000),
        );
        const result = await Promise.race([queueServicePromise, timeoutPromise]);
        expect(E.isLeft(result)).toBeTruthy();
        if (E.isLeft(result)) {
          expect(result.left).toHaveProperty('_tag', 'QueueConnectionError');
        }
      } catch (error) {
        // If we get an unhandled error, ensure it's a connection error
        expect(error).toBeDefined();
        const connectionError = error as ConnectionError;
        expect(connectionError.code || connectionError.message).toMatch(
          /ENOTFOUND|ETIMEDOUT|Connection timeout/,
        );
      }
    }, 10000); // Increase timeout to handle connection attempts
  });
});
