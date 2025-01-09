import IORedis from 'ioredis';
import { QUEUE_CONFIG } from '../../../src/config/queue/queue.config';
import { createQueueServiceImpl } from '../../../src/infrastructure/queue/core/queue.service';
import { createWorkerService } from '../../../src/infrastructure/queue/core/worker.service';
import { QueueService, WorkerService } from '../../../src/infrastructure/queue/types';
import { MetaJobData, MetaOperation } from '../../../src/types/job.type';
import { createTestMetaJobData } from '../../utils/queue.test.utils';

describe('Queue Reliability Tests', () => {
  const TEST_TIMEOUT = 180000; // 3 minutes
  const queueName = 'test-reliability-queue';
  let queueService: QueueService<MetaJobData>;
  let workerService: WorkerService<MetaJobData>;
  let redisClient: IORedis;

  beforeAll(async () => {
    // Create Redis client with remote configuration
    redisClient = new IORedis({
      host: QUEUE_CONFIG.REDIS.HOST,
      port: QUEUE_CONFIG.REDIS.PORT,
      password: QUEUE_CONFIG.REDIS.PASSWORD,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 3) return null;
        return Math.min(times * 1000, 3000);
      },
      enableReadyCheck: true,
      lazyConnect: false,
    });

    // Verify connection
    const pingResult = await redisClient.ping();
    if (pingResult !== 'PONG') {
      throw new Error('Redis connection failed');
    }
  });

  afterAll(async () => {
    // Close Redis connection
    if (redisClient?.status === 'ready') {
      await redisClient.quit();
    }
  });

  beforeEach(async () => {
    // Create queue service
    const queueResult = await createQueueServiceImpl<MetaJobData>(queueName)();
    if (queueResult._tag === 'Left') {
      throw new Error('Failed to create queue service');
    }
    queueService = queueResult.right;

    // Clean up any existing jobs
    await queueService.clean(0, 0, 'completed')();
  });

  afterEach(async () => {
    // Clean up and close services
    if (queueService) {
      await queueService.clean(0, 0, 'completed')();
      await queueService.close()();
    }
    if (workerService) {
      await workerService.close()();
    }
  });

  describe('Job Data Validation', () => {
    it('should validate job data correctly', async () => {
      // Create and start worker service
      const workerResult = await createWorkerService<MetaJobData>(queueName, async (job) => {
        console.log('Processing job:', job.id);
        await new Promise((resolve) => setTimeout(resolve, 100)); // Small delay to simulate work
        return;
      })();
      expect(workerResult._tag).toBe('Right');
      if (workerResult._tag === 'Right') {
        workerService = workerResult.right;
        await workerService.start()();
      }

      // Test invalid operation type
      const invalidOperationResult = await queueService.addJob(
        createTestMetaJobData({
          operation: 'INVALID_OP' as MetaOperation,
          name: 'meta',
        }),
      )();
      expect(invalidOperationResult._tag).toBe('Left');

      // Test missing name field
      const invalidJobResult = await queueService.addJob({
        type: 'META',
        data: {
          operation: 'SYNC',
          metaType: 'EVENTS',
        },
        timestamp: new Date(),
      } as unknown as MetaJobData)();
      expect(invalidJobResult._tag).toBe('Left');

      // Test valid job data
      const validResult = await queueService.addJob(
        createTestMetaJobData({
          operation: 'SYNC',
          name: 'meta',
        }),
      )();
      expect(validResult._tag).toBe('Right');

      // Wait for job to be processed with a more reliable check
      const queue = queueService.getQueue();
      const maxWaitTime = 30000; // 30 seconds
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitTime) {
        const jobs = await queue.getJobs(['completed']);
        if (jobs.length === 1) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Verify job was processed
      const completedJobs = await queue.getJobs(['completed']);
      expect(completedJobs.length).toBe(1);
    }, 60000); // Increased timeout
  });

  // ... rest of the tests remain unchanged ...
});
