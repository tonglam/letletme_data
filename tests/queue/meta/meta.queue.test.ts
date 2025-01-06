import { Job } from 'bullmq';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from '../../../src/config/queue/queue.config';
import {
  createMetaJobData,
  createMetaJobProcessor,
  createMetaQueueService,
} from '../../../src/queue/meta/meta.queue';
import { createQueueError, QueueError, QueueErrorCode } from '../../../src/types/errors.type';
import { MetaJobData, MetaOperation, MetaService, MetaType } from '../../../src/types/job.type';
import { createTestQueueConfig } from '../../utils/queue.test.utils';

describe('Meta Queue Tests', () => {
  let cleanupFunctions: Array<() => Promise<void>>;
  let mockJob: Job<MetaJobData>;
  const mockConfig = createTestQueueConfig({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
    password: process.env.REDIS_PASSWORD,
  });

  // Validate Redis configuration
  beforeAll(() => {
    if (!process.env.REDIS_HOST || !process.env.REDIS_PASSWORD) {
      console.warn('Redis configuration not found, using default localhost settings');
    }
  });

  beforeEach(() => {
    cleanupFunctions = [];
    mockJob = {
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
  });

  afterEach(async () => {
    // Add delay between cleanup operations
    for (const cleanup of cleanupFunctions) {
      await cleanup();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });

  describe('createMetaJobData', () => {
    it('should create valid meta job data with SYNC operation', () => {
      const operation: MetaOperation = 'SYNC';
      const metaType: MetaType = 'EVENTS';

      const jobData = createMetaJobData(operation, metaType);

      expect(jobData).toEqual({
        type: 'META',
        name: 'meta',
        timestamp: expect.any(Date),
        data: {
          operation,
          metaType,
        },
      });
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
    const mockMetaService: MetaService = {
      syncMeta: () => TE.right(undefined),
      syncEvents: () => TE.right(undefined),
    };

    it('should process job with valid processor', async () => {
      const mockProcessor = jest.fn((job: Job<MetaJobData>) => {
        expect(job).toBeDefined();
        return TE.right(undefined);
      });
      const processor = createMetaJobProcessor({
        EVENTS: mockProcessor,
      });

      const result = await processor(mockJob, mockMetaService)();

      expect(E.isRight(result)).toBeTruthy();
      expect(mockProcessor).toHaveBeenCalledWith(mockJob, mockMetaService);
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
      const mockError = new Error('Processing failed');
      const mockProcessor = jest.fn((job: Job<MetaJobData>) => {
        expect(job).toBeDefined();
        return TE.left(createQueueError(QueueErrorCode.PROCESSING_ERROR, 'test', mockError));
      });

      const processor = createMetaJobProcessor({
        EVENTS: mockProcessor,
      });

      const result = await processor(mockJob, mockMetaService)();

      expect(E.isLeft(result)).toBeTruthy();
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(QueueErrorCode.PROCESSING_ERROR);
        expect(result.left.error).toBe(mockError);
      }
    });
  });

  describe('createMetaQueueService', () => {
    const mockMetaService: MetaService = {
      syncMeta: () => TE.right(undefined),
      syncEvents: () => TE.right(undefined),
    };

    const mockProcessor = jest.fn((job: Job<MetaJobData>) => {
      expect(job).toBeDefined();
      return TE.right(undefined);
    });

    it('should create meta queue service successfully', async () => {
      const result = await createMetaQueueService(mockConfig, mockMetaService, mockProcessor)();

      expect(E.isRight(result)).toBeTruthy();
      if (E.isRight(result)) {
        const service = result.right;
        expect(service.addJob).toBeDefined();
        expect(service.worker).toBeDefined();
        cleanupFunctions.push(async () => {
          await service.worker.close();
          await service.obliterate()();
        });
      }
    });

    it('should process job through created service', async () => {
      const processorSpy = jest.fn((job: Job<MetaJobData>) => {
        expect(job.data).toEqual(mockJob.data);
        return TE.right(undefined);
      });

      const result = await pipe(
        createMetaQueueService(mockConfig, mockMetaService, processorSpy),
        TE.chain((service) => {
          cleanupFunctions.push(async () => {
            await service.worker.close();
            await service.obliterate()();
          });
          return service.addJob(mockJob.data);
        }),
      )();

      expect(E.isRight(result)).toBeTruthy();
      // Wait for the job to be processed with increased timeout
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(processorSpy).toHaveBeenCalled();
    });

    it('should handle service creation error', async () => {
      const invalidConfig = {
        connection: {
          host: 'invalid-host',
          port: -1,
        },
      } as QueueConfig;

      const result = await createMetaQueueService(invalidConfig, mockMetaService, mockProcessor)();

      expect(E.isLeft(result)).toBeTruthy();
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(QueueErrorCode.CREATE_WORKER);
      }
    });

    describe('Auto Run and Cleanup', () => {
      it('should automatically start processing jobs when created', async () => {
        const processorSpy = jest.fn((job: Job<MetaJobData>) => {
          expect(job.data).toEqual(mockJob.data);
          return TE.right(undefined);
        });

        const result = await pipe(
          createMetaQueueService(mockConfig, mockMetaService, processorSpy),
          TE.chain((service) => {
            cleanupFunctions.push(async () => {
              await service.worker.close();
              await service.obliterate()();
            });
            return service.addJob(mockJob.data);
          }),
        )();

        expect(E.isRight(result)).toBeTruthy();
        // Wait for the job to be processed with increased timeout
        await new Promise((resolve) => setTimeout(resolve, 2000));
        expect(processorSpy).toHaveBeenCalled();
      });

      it('should handle errors during auto cleanup', async () => {
        const mockError = new Error('Cleanup failed');
        const errorMetaService: MetaService = {
          syncMeta: () =>
            TE.left(createQueueError(QueueErrorCode.PROCESSING_ERROR, 'test', mockError)),
          syncEvents: () => TE.right(undefined),
        };

        const result = await pipe(
          createMetaQueueService(mockConfig, errorMetaService, mockProcessor),
          TE.chain((service) => {
            cleanupFunctions.push(async () => {
              await service.worker.close();
            });
            return pipe(
              service.syncMeta('EVENTS'),
              TE.chain(() => service.obliterate()),
            );
          }),
        )();

        expect(E.isLeft(result)).toBeTruthy();
        if (E.isLeft(result)) {
          const error = result.left as QueueError;
          expect(error.code).toBe(QueueErrorCode.PROCESSING_ERROR);
          expect(error.error).toBe(mockError);
        }
      });
    });
  });
});
