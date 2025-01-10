import { Job } from 'bullmq';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { CachePrefix } from '../../../src/config/cache/cache.config';
import { createBootstrapApiAdapter } from '../../../src/domain/bootstrap/adapter';
import { createEventRepository } from '../../../src/domain/event/repository';
import { redisClient } from '../../../src/infrastructure/cache/client';
import { prisma } from '../../../src/infrastructure/db/prisma';
import { DEFAULT_RETRY_CONFIG } from '../../../src/infrastructure/http/client/utils';
import { createFPLClient } from '../../../src/infrastructure/http/fpl/client';
import { createEventMetaQueueService } from '../../../src/queue/meta/event.meta.queue';
import { createEventService } from '../../../src/service/event';
import { getCurrentSeason } from '../../../src/types/base.type';
import { QueueError, QueueErrorCode } from '../../../src/types/error.type';
import {
  EventMetaService,
  MetaJobData,
  MetaQueueService,
  MetaType,
} from '../../../src/types/job.type';

// Create repositories
const eventRepository = createEventRepository(prisma);

describe('Event Meta Queue Integration Tests', () => {
  const TEST_TIMEOUT = 30000;
  let queueService: MetaQueueService;
  let eventMetaService: EventMetaService;

  // Test-specific cache keys
  const TEST_CACHE_PREFIX = `${CachePrefix.EVENT}::test`;
  const testCacheKey = `${TEST_CACHE_PREFIX}::${getCurrentSeason()}`;
  const testCurrentEventKey = `${testCacheKey}::current`;
  const testNextEventKey = `${testCacheKey}::next`;

  // Validate Redis configuration
  beforeAll(async () => {
    if (!process.env.REDIS_HOST || !process.env.REDIS_PASSWORD) {
      throw new Error('Redis configuration is missing. Please check your .env file.');
    }

    try {
      // Wait for Redis connection
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Clear existing data
      await prisma.event.deleteMany();

      // Clear test-specific cache keys
      const multi = redisClient.multi();
      multi.del(testCacheKey);
      multi.del(testCurrentEventKey);
      multi.del(testNextEventKey);
      await multi.exec();

      // Create services
      const fplClient = createFPLClient({
        retryConfig: {
          ...DEFAULT_RETRY_CONFIG,
          attempts: 3,
          baseDelay: 500,
          maxDelay: 2000,
        },
      });
      const bootstrapApi = createBootstrapApiAdapter(fplClient);
      const eventService = createEventService(bootstrapApi, eventRepository);

      eventMetaService = {
        syncMeta: (metaType: MetaType) => {
          if (metaType === 'EVENTS') {
            return pipe(
              eventService.syncEventsFromApi(),
              TE.mapLeft(toQueueError),
              TE.map(() => void 0),
            );
          }
          return TE.left(toQueueError(new Error(`Unsupported meta type: ${metaType}`)));
        },
        syncEvents: () =>
          pipe(
            eventService.syncEventsFromApi(),
            TE.mapLeft(toQueueError),
            TE.map(() => void 0),
          ),
      };

      // Create queue service
      const queueResult = await createEventMetaQueueService(eventMetaService)();

      if (E.isLeft(queueResult)) {
        throw new Error('Failed to create queue service');
      }

      queueService = queueResult.right;

      // Wait for worker to be ready by checking queue status
      await new Promise<void>((resolve) => {
        const checkWorker = async () => {
          const isPaused = await queueService.getQueue().isPaused();
          if (!isPaused) {
            console.log('Queue is active and ready');
            resolve();
          } else {
            console.log('Queue is paused, waiting...');
            setTimeout(checkWorker, 1000);
          }
        };
        checkWorker();
      });

      // Clear existing jobs
      await executeQueueOperation(
        pipe(
          queueService.pause(),
          TE.chain(() => queueService.clean(0, 1000, 'completed')),
          TE.chain(() => queueService.resume()),
        ),
      );
    } catch (error) {
      console.error('Error in beforeAll:', error);
      throw error;
    }
  }, TEST_TIMEOUT);

  afterAll(async () => {
    try {
      if (queueService) {
        await executeQueueOperation(
          pipe(
            queueService.pause(),
            TE.chain(() => queueService.clean(0, 1000, 'completed')),
          ),
        );
        await queueService.close();
      }

      // Clean up test data
      await prisma.event.deleteMany();

      // Clean up test-specific cache keys
      const multi = redisClient.multi();
      multi.del(testCacheKey);
      multi.del(testCurrentEventKey);
      multi.del(testNextEventKey);
      await multi.exec();

      // Close connections
      await redisClient.quit();
      await prisma.$disconnect();
    } catch (error) {
      console.error('Error in afterAll:', error);
      throw error;
    }
  });

  const toQueueError = (error: Error): QueueError => ({
    code: QueueErrorCode.PROCESSING_ERROR,
    context: 'queue',
    error,
  });

  const executeQueueOperation = async <T>(
    operation: TE.TaskEither<QueueError, T>,
  ): Promise<void> => {
    const result = await operation();
    if (E.isLeft(result)) {
      throw result.left;
    }
  };

  it(
    'should process event sync job successfully',
    async () => {
      // Create and add job
      const jobData: MetaJobData = {
        type: 'META',
        name: 'meta',
        timestamp: new Date(),
        data: {
          operation: 'SYNC',
          metaType: 'EVENTS',
        },
      };

      console.log('Adding job to queue...');
      await executeQueueOperation(queueService.addJob(jobData));

      // Wait for job processing with status checks
      console.log('Waiting for job processing...');
      let jobs: Job<MetaJobData>[] = [];
      let attempts = 0;
      const maxAttempts = 10;
      const checkInterval = 1000; // 1 second

      while (attempts < maxAttempts) {
        jobs = await queueService.getQueue().getJobs(['completed']);
        if (jobs.length > 0) {
          console.log('Job completed successfully');
          break;
        }
        console.log(`Attempt ${attempts + 1}/${maxAttempts}: Job still processing...`);
        await new Promise((resolve) => setTimeout(resolve, checkInterval));
        attempts++;
      }

      expect(jobs.length).toBeGreaterThan(0);
      if (jobs.length > 0) {
        const job = jobs[0];
        expect(job.data).toMatchObject(jobData);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'should handle sync failures gracefully',
    async () => {
      const jobData: MetaJobData = {
        type: 'META',
        name: 'meta',
        timestamp: new Date(),
        data: {
          operation: 'SYNC',
          metaType: 'EVENTS',
        },
      };

      await executeQueueOperation(queueService.addJob(jobData));

      // Wait for job processing
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const failedJobs = await queueService.getQueue().getJobs(['failed']);
      expect(failedJobs.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'should respect rate limiting for multiple sync operations',
    async () => {
      const jobs = Array.from(
        { length: 3 },
        () =>
          ({
            type: 'META',
            name: 'meta',
            timestamp: new Date(),
            data: {
              operation: 'SYNC',
              metaType: 'EVENTS',
            },
          }) as MetaJobData,
      );

      await Promise.all(jobs.map((job) => executeQueueOperation(queueService.addJob(job))));

      // Wait for job processing
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const completedJobs = await queueService.getQueue().getJobs(['completed']);
      expect(completedJobs.length).toBeGreaterThanOrEqual(3);
    },
    TEST_TIMEOUT,
  );

  it(
    'should not process jobs while paused',
    async () => {
      await executeQueueOperation(queueService.pause());

      const jobData: MetaJobData = {
        type: 'META',
        name: 'meta',
        timestamp: new Date(),
        data: {
          operation: 'SYNC',
          metaType: 'EVENTS',
        },
      };

      await executeQueueOperation(queueService.addJob(jobData));

      // Wait briefly
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const waitingJobs = await queueService.getQueue().getJobs(['waiting']);
      expect(waitingJobs.length).toBeGreaterThan(0);

      // Resume the queue for cleanup
      await executeQueueOperation(queueService.resume());
    },
    TEST_TIMEOUT,
  );
});
