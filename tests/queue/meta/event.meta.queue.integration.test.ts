import { Job } from 'bullmq';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { createEventMetaQueueService } from 'src/queue/meta/event.meta.queue';
import { EventMetaService, MetaJobData } from 'src/types/job.type';

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
    // Clean up resources after each test
    for (const cleanup of cleanupFunctions) {
      await cleanup();
    }
  });

  describe('Event Meta Queue Workflow', () => {
    it('should process event sync job successfully', async () => {
      // Create queue service
      const result = await createEventMetaQueueService(config, eventMetaService)();
      expect(E.isRight(result)).toBeTruthy();

      if (E.isRight(result)) {
        const queueService = result.right;
        // Add cleanup
        cleanupFunctions.push(async () => {
          await queueService.close();
        });

        // Create a mock job
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

        // Process the job
        const processResult = await queueService.processJob(mockJob)();
        expect(E.isRight(processResult)).toBeTruthy();

        // Verify event sync was called
        expect(eventMetaService.syncEvents).toHaveBeenCalled();
      }
    });

    it('should handle sync failures appropriately', async () => {
      // Mock sync failure
      const mockError = new Error('Sync failed');
      // Create new event meta service with error behavior
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
        } as Job<MetaJobData>;

        // Process should return Left
        const processResult = await queueService.processJob(mockJob)();
        expect(E.isLeft(processResult)).toBeTruthy();
      }
    });

    it('should handle multiple sync operations', async () => {
      const result = await createEventMetaQueueService(config, eventMetaService)();
      expect(E.isRight(result)).toBeTruthy();

      if (E.isRight(result)) {
        const queueService = result.right;
        cleanupFunctions.push(async () => {
          await queueService.close();
        });

        // Add multiple sync jobs and wait for them to complete
        await Promise.all([
          queueService.syncMeta('EVENTS')(),
          queueService.syncMeta('EVENTS')(),
          queueService.syncMeta('EVENTS')(),
        ]);

        // Verify sync was called multiple times
        expect(eventMetaService.syncEvents).toHaveBeenCalledTimes(3);
      }
    });

    it('should handle connection errors', async () => {
      const invalidConfig = {
        connection: {
          host: 'invalid-host',
          port: 6379,
          retryStrategy: () => 0, // Return 0 to disable retries
        },
      };

      // Should return Left for invalid config
      const result = await createEventMetaQueueService(invalidConfig, eventMetaService)();
      expect(E.isLeft(result)).toBeTruthy();
    }, 10000); // Increase timeout for connection error test
  });
});
