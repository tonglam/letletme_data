import { Queue, QueueEvents } from 'bullmq';
import { EventEmitter } from 'events';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { Logger } from 'pino';
import { createMonitorAdapter } from '../../../../src/infrastructure/queue/core/monitor.adapter';
import { createMonitorService } from '../../../../src/infrastructure/queue/core/monitor.service';
import { QueueMetrics } from '../../../../src/infrastructure/queue/types';

interface TestConfig {
  metricsInterval: number;
  historySize: number;
}

interface TestQueueEvents extends QueueEvents {
  emit(event: 'active', data: { jobId: string; type: string; timestamp: Date }): boolean;
  emit(event: 'completed', data: { jobId: string; returnvalue: string }): boolean;
  emit(event: 'failed', data: { jobId: string; failedReason: string }): boolean;
  emit(event: 'progress', data: { jobId: string; data: number }): boolean;
}

interface TestMonitorOperations {
  start: () => TE.TaskEither<Error, void>;
  stop: () => TE.TaskEither<Error, void>;
  getMetrics: () => TE.TaskEither<Error, QueueMetrics>;
  getMonitor: (queueName: string) => { _tag: 'Some' | 'None'; value: TestMonitorOperations };
}

describe('Queue Monitor', () => {
  let queue: Queue;
  let events: TestQueueEvents;
  let logger: Logger;
  let config: TestConfig;

  beforeEach(() => {
    queue = {
      name: 'test-queue',
      getJobCounts: jest.fn().mockResolvedValue({
        active: 1,
        waiting: 2,
        completed: 3,
        failed: 1,
        delayed: 0,
      }),
    } as unknown as Queue;

    events = Object.assign(new EventEmitter(), {
      emit: jest.fn().mockImplementation((event, data) => {
        return EventEmitter.prototype.emit.call(events, event, data);
      }),
    }) as unknown as TestQueueEvents;

    logger = {
      info: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as Logger;

    config = {
      metricsInterval: 100,
      historySize: 5,
    };

    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('Monitor Adapter', () => {
    it('should start and stop monitoring', async () => {
      const monitor = createMonitorAdapter({ queue, events, logger, config });

      // Start monitoring
      const startResult = await monitor.start()();
      expect(E.isRight(startResult)).toBe(true);
      expect(logger.info).toHaveBeenCalledWith(
        { queueName: queue.name },
        'Queue monitoring started',
        { timestamp: expect.any(Number) },
      );

      // Stop monitoring
      const stopResult = await monitor.stop()();
      expect(E.isRight(stopResult)).toBe(true);
      expect(logger.info).toHaveBeenCalledWith(
        { queueName: queue.name },
        'Queue monitoring stopped',
        { timestamp: expect.any(Number) },
      );
    });

    it('should collect metrics', async () => {
      const monitor = createMonitorAdapter({ queue, events, logger, config });
      const startResult = await monitor.start()();
      expect(E.isRight(startResult)).toBe(true);

      // Wait for metrics collection
      jest.advanceTimersByTime(config.metricsInterval + 50);
      await Promise.resolve(); // Let promises resolve

      const metricsResult = await monitor.getMetrics()();
      expect(E.isRight(metricsResult)).toBe(true);
      if (E.isRight(metricsResult)) {
        expect(metricsResult.right).toEqual(
          expect.objectContaining({
            activeJobs: 1,
            waitingJobs: 2,
            completedJobs: 3,
            failedJobs: 1,
            delayedJobs: 0,
          }),
        );
      }

      const stopResult = await monitor.stop()();
      expect(E.isRight(stopResult)).toBe(true);
    });

    it('should track job lifecycle events', async () => {
      const monitor = createMonitorAdapter({ queue, events, logger, config });
      const startResult = await monitor.start()();
      expect(E.isRight(startResult)).toBe(true);

      const jobId = 'test-job-1';
      const returnvalue = 'test-result';
      const timestamp = new Date();
      const jobType = 'TEST_JOB';

      // Mock Date.now() for consistent timestamps
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(timestamp.getTime());

      // Initialize job metrics
      events.emit('active', { jobId, type: jobType, timestamp });

      // Clear logger mocks after initialization
      jest.clearAllMocks();

      // Simulate job completion
      events.emit('completed', { jobId, returnvalue });
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId,
          queueName: queue.name,
          type: jobType,
        }),
        'Job completed successfully',
        { timestamp: timestamp.getTime() },
      );

      // Simulate job failure
      events.emit('failed', { jobId, failedReason: 'Test failure' });
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId,
          queueName: queue.name,
          type: jobType,
          reason: 'Test failure',
        }),
        'Job failed',
        { timestamp: timestamp.getTime() },
      );

      // Simulate progress update
      events.emit('progress', { jobId, data: 50 });
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId,
          queueName: queue.name,
          type: jobType,
          progress: '50%',
        }),
        'Job progress updated',
        { timestamp: timestamp.getTime() },
      );

      dateSpy.mockRestore();

      const stopResult = await monitor.stop()();
      expect(E.isRight(stopResult)).toBe(true);
    });

    it('should handle errors during metrics collection', async () => {
      const failingQueue = {
        ...queue,
        getJobCounts: jest.fn().mockRejectedValue(new Error('Test error')),
      } as unknown as Queue;

      const monitor = createMonitorAdapter({ queue: failingQueue, events, logger, config });
      const startResult = await monitor.start()();
      expect(E.isRight(startResult)).toBe(true);

      // Wait for metrics collection attempt
      jest.advanceTimersByTime(config.metricsInterval + 50);
      await Promise.resolve(); // Let promises resolve

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.any(Error),
          queueName: failingQueue.name,
        }),
        'Error collecting queue metrics',
        { timestamp: expect.any(Number) },
      );

      const stopResult = await monitor.stop()();
      expect(E.isRight(stopResult)).toBe(true);
    });
  });

  describe('Monitor Service', () => {
    it('should create and manage monitors for multiple queues', async () => {
      const monitorService = createMonitorService({ queue, events, logger, config });
      const monitor = monitorService as unknown as TestMonitorOperations;

      // Start monitoring for the default queue
      const startResult = await monitor.start()();
      expect(E.isRight(startResult)).toBe(true);

      // Get monitor for a different queue
      const otherQueueMonitor = monitorService.getMonitor('other-queue');
      expect(otherQueueMonitor._tag).toBe('None');

      // Get monitor for the default queue
      const defaultQueueMonitor = monitorService.getMonitor(queue.name);
      expect(defaultQueueMonitor._tag).toBe('Some');

      const stopResult = await monitor.stop()();
      expect(E.isRight(stopResult)).toBe(true);
    });

    it('should share metrics across monitor instances', async () => {
      const monitorService = createMonitorService({ queue, events, logger, config });
      const monitor = monitorService as unknown as TestMonitorOperations;
      const startResult = await monitor.start()();
      expect(E.isRight(startResult)).toBe(true);

      // Wait for metrics collection
      jest.advanceTimersByTime(config.metricsInterval + 50);
      await Promise.resolve(); // Let promises resolve

      const serviceMetricsResult = await monitor.getMetrics()();
      expect(E.isRight(serviceMetricsResult)).toBe(true);

      const defaultQueueMonitor = monitorService.getMonitor(queue.name);
      expect(defaultQueueMonitor._tag).toBe('Some');

      if (E.isRight(serviceMetricsResult) && defaultQueueMonitor._tag === 'Some') {
        const monitorMetricsResult = await defaultQueueMonitor.value.getMetrics()();
        expect(E.isRight(monitorMetricsResult)).toBe(true);

        if (E.isRight(monitorMetricsResult)) {
          expect(serviceMetricsResult.right).toEqual(monitorMetricsResult.right);
        }
      }

      const stopResult = await monitor.stop()();
      expect(E.isRight(stopResult)).toBe(true);
    });
  });
});
