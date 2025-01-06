import { Job } from 'bullmq';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { QUEUE_CONFIG } from '../../../src/config/queue/queue.config';
import {
  createMetaJobData,
  createMetaJobProcessor,
  createMetaQueueService,
  MetaJobProcessor,
} from '../../../src/queue/meta/meta.queue';
import { createQueueError, QueueErrorCode } from '../../../src/types/errors.type';
import { MetaJobData, MetaService, MetaType } from '../../../src/types/job.type';
import { QueueConfig } from '../../../src/types/queue.type';

describe('meta.queue', () => {
  const mockConfig: QueueConfig = {
    connection: {
      host: 'localhost',
      port: 6379,
    },
  };

  const mockMetaService: MetaService = {
    syncMeta: () => TE.right(undefined),
    syncEvents: () => TE.right(undefined),
  };

  const mockJob: Job<MetaJobData> = {
    data: createMetaJobData('SYNC', 'EVENTS'),
  } as Job<MetaJobData>;

  const mockProcessor: Partial<Record<MetaType, MetaJobProcessor>> = {
    EVENTS: () => TE.right(undefined),
  };

  const cleanupFunctions: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanupFunctions) {
      await cleanup();
    }
    cleanupFunctions.length = 0;
  });

  describe('createMetaJobData', () => {
    it('should create valid meta job data with SYNC operation', () => {
      const jobData = createMetaJobData('SYNC', 'EVENTS');
      expect(jobData.type).toBe('META');
      expect(jobData.name).toBe('meta');
      expect(jobData.data.operation).toBe('SYNC');
      expect(jobData.data.metaType).toBe('EVENTS');
      expect(jobData.timestamp).toBeInstanceOf(Date);
    });

    it('should create job data with current timestamp', () => {
      const before = new Date();
      const jobData = createMetaJobData('SYNC', 'EVENTS');
      const after = new Date();
      expect(jobData.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(jobData.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('createMetaJobProcessor', () => {
    it('should process job with valid processor', async () => {
      const processor = createMetaJobProcessor(mockProcessor);
      const result = await processor(mockJob, mockMetaService)();
      expect(E.isRight(result)).toBeTruthy();
    });

    it('should handle missing processor error', async () => {
      const processor = createMetaJobProcessor({});
      const result = await processor(mockJob, mockMetaService)();
      expect(E.isLeft(result)).toBeTruthy();
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(QueueErrorCode.PROCESSING_ERROR);
        expect(result.left.context).toBe('meta');
      }
    });

    it('should handle processor execution error', async () => {
      const error = new Error('Processor error');
      const failingProcessor: Partial<Record<MetaType, MetaJobProcessor>> = {
        EVENTS: () => TE.left(createQueueError(QueueErrorCode.PROCESSING_ERROR, 'meta', error)),
      };
      const processor = createMetaJobProcessor(failingProcessor);
      const result = await processor(mockJob, mockMetaService)();
      expect(E.isLeft(result)).toBeTruthy();
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(QueueErrorCode.PROCESSING_ERROR);
        expect(result.left.context).toBe('meta');
      }
    });
  });

  describe('createMetaQueueService', () => {
    it('should create meta queue service with correct worker options', async () => {
      const result = await createMetaQueueService(
        mockConfig,
        mockMetaService,
        createMetaJobProcessor(mockProcessor),
      )();
      expect(E.isRight(result)).toBeTruthy();
      if (E.isRight(result)) {
        const service = result.right;
        expect(service.worker).toBeDefined();
        cleanupFunctions.push(() => service.close());
      }
    });

    it(
      'should handle job retries with backoff',
      async () => {
        const retryProcessor: Partial<Record<MetaType, MetaJobProcessor>> = {
          EVENTS: () =>
            TE.left(
              createQueueError(QueueErrorCode.PROCESSING_ERROR, 'meta', new Error('First attempt')),
            ),
        };

        const result = await createMetaQueueService(
          mockConfig,
          mockMetaService,
          createMetaJobProcessor(retryProcessor),
        )();
        expect(E.isRight(result)).toBeTruthy();
        if (E.isRight(result)) {
          const service = result.right;
          await service.addJob(mockJob.data)();
          await new Promise((resolve) => setTimeout(resolve, QUEUE_CONFIG.INITIAL_BACKOFF * 2));
          cleanupFunctions.push(() => service.close());
        }
      },
      QUEUE_CONFIG.JOB_TIMEOUT * 2,
    );

    it(
      'should handle pause and resume operations',
      async () => {
        const result = await createMetaQueueService(
          mockConfig,
          mockMetaService,
          createMetaJobProcessor(mockProcessor),
        )();
        expect(E.isRight(result)).toBeTruthy();
        if (E.isRight(result)) {
          const service = result.right;
          await service.worker.pause();
          expect(await service.worker.isPaused()).toBeTruthy();
          await service.worker.resume();
          expect(await service.worker.isPaused()).toBeFalsy();
          cleanupFunctions.push(() => service.close());
        }
      },
      QUEUE_CONFIG.JOB_TIMEOUT * 2,
    );

    it(
      'should handle rate limiting',
      async () => {
        const result = await createMetaQueueService(
          mockConfig,
          mockMetaService,
          createMetaJobProcessor(mockProcessor),
        )();
        expect(E.isRight(result)).toBeTruthy();
        if (E.isRight(result)) {
          const service = result.right;
          const startTime = Date.now();

          // Add more jobs than the rate limit allows
          const jobCount = QUEUE_CONFIG.RATE_LIMIT.MAX * 2;
          await Promise.all(
            Array.from({ length: jobCount }).map(() => service.addJob(mockJob.data)()),
          );

          // Wait for jobs to be processed
          await new Promise((resolve) => setTimeout(resolve, QUEUE_CONFIG.RATE_LIMIT.DURATION));

          const duration = Date.now() - startTime;
          expect(duration).toBeGreaterThanOrEqual(QUEUE_CONFIG.RATE_LIMIT.DURATION);
          cleanupFunctions.push(() => service.close());
        }
      },
      QUEUE_CONFIG.JOB_TIMEOUT * 2,
    );
  });
});
