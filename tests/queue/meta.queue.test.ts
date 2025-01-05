import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from '../../../src/config/queue/queue.config';
import { createMetaQueueService } from '../../../src/queue/meta/meta.queue';
import { MetaService } from '../../../src/types/job.type';

describe('MetaQueueService', () => {
  // Test fixtures
  const queueConfig: QueueConfig = {
    producerConnection: {
      host: 'localhost',
      port: 6379,
    },
    consumerConnection: {
      host: 'localhost',
      port: 6379,
    },
  };

  const metaService: MetaService = {
    startWorker: () => TE.right(undefined),
    stopWorker: () => TE.right(undefined),
    cleanup: () => TE.right(undefined),
  };

  describe('createMetaQueueService', () => {
    it('should create a meta queue service successfully', async () => {
      const result = await pipe(
        createMetaQueueService(queueConfig, metaService),
        TE.map((service) => {
          expect(service).toBeDefined();
          expect(service.processJob).toBeDefined();
          expect(service.startWorker).toBeDefined();
          expect(service.stopWorker).toBeDefined();
          expect(service.syncMeta).toBeDefined();
          expect(service.cleanupMeta).toBeDefined();
          return service;
        }),
      )();

      expect(result._tag).toBe('Right');
    });
  });

  describe('processJob', () => {
    it('should process SYNC operation successfully', async () => {
      const metaQueueService = await pipe(
        createMetaQueueService(queueConfig, metaService),
        TE.getOrElse(() => {
          throw new Error('Failed to create meta queue service');
        }),
      )();

      const result = await metaQueueService.syncMeta('EVENTS')();

      expect(result._tag).toBe('Right');
    });

    it('should process CLEANUP operation successfully', async () => {
      const metaQueueService = await pipe(
        createMetaQueueService(queueConfig, metaService),
        TE.getOrElse(() => {
          throw new Error('Failed to create meta queue service');
        }),
      )();

      const result = await metaQueueService.cleanupMeta('EVENTS')();

      expect(result._tag).toBe('Right');
    });
  });
});
