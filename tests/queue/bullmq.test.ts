import { Queue, QueueEvents, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import {
  closeRedisClient,
  createRedisClient,
  TEST_OPTIONS,
} from '../../src/infrastructure/redis/client';

describe('BullMQ Basic Tests', () => {
  const TEST_PREFIX = 'test:bullmq:';
  let redisClient: Redis;
  let queue: Queue<SerializedTestJobData>;
  let worker: Worker<SerializedTestJobData>;

  // Test job data types
  interface TestJobData {
    type: 'TEST';
    timestamp: Date;
    data: {
      value: string;
    };
  }

  interface SerializedTestJobData {
    type: 'TEST';
    timestamp: string;
    data: {
      value: string;
    };
  }

  // Helper function to serialize job data
  const serializeJobData = (data: TestJobData): SerializedTestJobData => ({
    type: data.type,
    timestamp: data.timestamp.toISOString(),
    data: data.data,
  });

  beforeAll(async () => {
    // Create Redis client with test options
    const clientResult = await createRedisClient({
      ...TEST_OPTIONS,
      keyPrefix: '', // Disable keyPrefix for tests
    })();
    expect(clientResult._tag).toBe('Right');
    if (clientResult._tag === 'Left') {
      throw new Error('Failed to create Redis client');
    }
    redisClient = clientResult.right;
  });

  beforeEach(async () => {
    // Clean up any existing test keys
    const existingKeys = await redisClient.keys(`${TEST_PREFIX}*`);
    if (existingKeys.length > 0) {
      await redisClient.del(...existingKeys);
    }

    // Create queue with test configuration
    queue = new Queue<SerializedTestJobData>('test-queue', {
      connection: {
        host: TEST_OPTIONS.host,
        port: TEST_OPTIONS.port,
        password: TEST_OPTIONS.password,
        maxRetriesPerRequest: null,
        retryStrategy: (times: number) => Math.min(times * 10, 100),
      },
      prefix: TEST_PREFIX,
    });
  });

  afterEach(async () => {
    // Close queue and worker
    await queue?.close();
    await worker?.close();
  });

  afterAll(async () => {
    // Clean up test keys and close Redis client
    const keys = await redisClient.keys(`${TEST_PREFIX}*`);
    if (keys.length > 0) {
      await redisClient.del(...keys);
    }
    await closeRedisClient();
  });

  it('should create queue with default settings', async () => {
    expect(queue).toBeDefined();
    expect(queue.name).toBe('test-queue');
    expect(queue.opts.prefix).toBe(TEST_PREFIX);
  });

  it('should create worker with default settings', async () => {
    worker = new Worker<SerializedTestJobData>(
      'test-queue',
      async (job) => {
        return job.data.data.value;
      },
      {
        connection: queue.opts.connection,
        prefix: TEST_PREFIX,
        lockDuration: 1000,
        stalledInterval: 1000,
      },
    );

    expect(worker).toBeDefined();
    expect(worker.name).toBe('test-queue');
    expect(worker.opts.prefix).toBe(TEST_PREFIX);
  });

  it('should add job to queue', async () => {
    const jobData: TestJobData = {
      type: 'TEST',
      timestamp: new Date(),
      data: {
        value: 'test-value',
      },
    };

    // Convert to serialized form for queue
    const serializedJobData: SerializedTestJobData = {
      type: jobData.type,
      timestamp: jobData.timestamp.toISOString(),
      data: jobData.data,
    };

    const job = await queue.add('test-job', serializedJobData);
    expect(job).toBeDefined();
    expect(job.name).toBe('test-job');

    // Verify the job data structure
    expect(job.data).toEqual(serializedJobData);

    // Verify job in Redis
    const jobs = await queue.getJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toEqual(serializedJobData);
  });

  it('should process job successfully', async () => {
    // Create a promise to track job completion
    const jobCompleted = new Promise<string>((resolve) => {
      worker = new Worker<SerializedTestJobData>(
        'test-queue',
        async (job) => {
          const result = job.data.data.value;
          resolve(result);
          return result;
        },
        {
          connection: queue.opts.connection,
          prefix: TEST_PREFIX,
          lockDuration: 1000,
          stalledInterval: 1000,
        },
      );
    });

    // Add job to queue
    const jobData: TestJobData = {
      type: 'TEST',
      timestamp: new Date(),
      data: {
        value: 'test-value',
      },
    };

    await queue.add('test-job', serializeJobData(jobData));

    // Wait for job completion
    const result = await jobCompleted;
    expect(result).toBe('test-value');
  });

  it('should handle job completion events', async () => {
    // Create promises to track job events
    const jobCompleted = new Promise<void>((resolve) => {
      worker = new Worker<SerializedTestJobData>(
        'test-queue',
        async (job) => {
          const result = job.data.data.value;
          resolve();
          return result;
        },
        {
          connection: queue.opts.connection,
          prefix: TEST_PREFIX,
          lockDuration: 1000,
          stalledInterval: 1000,
        },
      );
    });

    // Add job to queue
    const jobData: TestJobData = {
      type: 'TEST',
      timestamp: new Date(),
      data: {
        value: 'test-value',
      },
    };

    await queue.add('test-job', serializeJobData(jobData));

    // Wait for completion event
    await jobCompleted;
    expect(true).toBe(true); // Event was received
  });

  it('should handle job failure events', async () => {
    // Create promises to track job events
    const jobFailed = new Promise<Error>((resolve) => {
      worker = new Worker<SerializedTestJobData>(
        'test-queue',
        async () => {
          throw new Error('Test error');
        },
        {
          connection: queue.opts.connection,
          prefix: TEST_PREFIX,
          lockDuration: 1000,
          stalledInterval: 1000,
        },
      );

      worker.on('failed', (job, error) => {
        resolve(error as Error);
      });
    });

    // Add job to queue
    const jobData: TestJobData = {
      type: 'TEST',
      timestamp: new Date(),
      data: {
        value: 'test-value',
      },
    };

    await queue.add('test-job', serializeJobData(jobData));

    // Wait for failure event
    const error = await jobFailed;
    expect(error.message).toBe('Test error');
  });

  it('should handle job priority', async () => {
    const jobCompletionOrder: string[] = [];
    const processingDelay = 50; // Add a small delay to ensure consistent processing order

    worker = new Worker<SerializedTestJobData>(
      'test-queue',
      async (job) => {
        await new Promise((resolve) => setTimeout(resolve, processingDelay));
        jobCompletionOrder.push(job.data.data.value);
        return job.data.data.value;
      },
      {
        connection: queue.opts.connection,
        prefix: TEST_PREFIX,
        concurrency: 1, // Ensure sequential processing
      },
    );

    // Add jobs with different priorities (lower number = higher priority)
    const baseJobData: TestJobData = {
      type: 'TEST',
      timestamp: new Date(),
      data: { value: '' },
    };

    await Promise.all([
      queue.add('low-priority', serializeJobData({ ...baseJobData, data: { value: 'low' } }), {
        priority: 3,
      }),
      queue.add('high-priority', serializeJobData({ ...baseJobData, data: { value: 'high' } }), {
        priority: 1,
      }),
      queue.add(
        'medium-priority',
        serializeJobData({ ...baseJobData, data: { value: 'medium' } }),
        { priority: 2 },
      ),
    ]);

    // Wait for all jobs to complete (3 jobs * processingDelay + buffer)
    await new Promise((resolve) => setTimeout(resolve, processingDelay * 4));

    expect(jobCompletionOrder).toEqual(['high', 'medium', 'low']);
  });

  it('should handle job removal', async () => {
    // Add a job
    const jobData: TestJobData = {
      type: 'TEST',
      timestamp: new Date(),
      data: { value: 'to-be-removed' },
    };

    const job = await queue.add('removable-job', serializeJobData(jobData));

    // Verify job exists
    let jobs = await queue.getJobs();
    expect(jobs).toHaveLength(1);

    // Remove the job
    await job.remove();

    // Verify job was removed
    jobs = await queue.getJobs();
    expect(jobs).toHaveLength(0);
  });

  it('should handle job retries', async () => {
    let attempts = 0;
    const maxAttempts = 3;

    worker = new Worker<SerializedTestJobData>(
      'test-queue',
      async () => {
        attempts++;
        if (attempts < maxAttempts) {
          throw new Error('Retry needed');
        }
        return 'success';
      },
      {
        connection: queue.opts.connection,
        prefix: TEST_PREFIX,
      },
    );

    // Add job with retry settings
    const jobData: TestJobData = {
      type: 'TEST',
      timestamp: new Date(),
      data: { value: 'retry-test' },
    };

    await queue.add('retry-job', serializeJobData(jobData), { attempts: maxAttempts });

    // Wait for retries to complete
    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(attempts).toBe(maxAttempts);
  });

  it('should handle concurrent job processing', async () => {
    const processedJobs: string[] = [];
    const concurrency = 3;

    worker = new Worker<SerializedTestJobData>(
      'test-queue',
      async (job) => {
        await new Promise((resolve) => setTimeout(resolve, 100)); // Simulate work
        processedJobs.push(job.data.data.value);
        return job.data.data.value;
      },
      {
        connection: queue.opts.connection,
        prefix: TEST_PREFIX,
        concurrency,
      },
    );

    // Add multiple jobs
    const baseJobData: TestJobData = {
      type: 'TEST',
      timestamp: new Date(),
      data: { value: '' },
    };

    const jobPromises = Array.from({ length: 5 }).map((_, i) =>
      queue.add(
        `concurrent-job-${i}`,
        serializeJobData({
          ...baseJobData,
          data: { value: `job-${i}` },
        }),
      ),
    );

    await Promise.all(jobPromises);

    // Wait for all jobs to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(processedJobs).toHaveLength(5);
  });

  it('should handle queue events', async () => {
    const events: string[] = [];
    const queueEvents = new QueueEvents('test-queue', {
      connection: queue.opts.connection,
      prefix: TEST_PREFIX,
    });

    // Create a promise that resolves when all expected events are received
    const allEventsReceived = new Promise<void>((resolve) => {
      const expectedEvents = new Set(['waiting', 'active', 'completed']);
      queueEvents.on('waiting', () => {
        events.push('waiting');
        if (events.length === expectedEvents.size) resolve();
      });
      queueEvents.on('active', () => {
        events.push('active');
        if (events.length === expectedEvents.size) resolve();
      });
      queueEvents.on('completed', () => {
        events.push('completed');
        if (events.length === expectedEvents.size) resolve();
      });
    });

    // Wait for events to be ready
    await new Promise((resolve) => setTimeout(resolve, 100));

    worker = new Worker<SerializedTestJobData>('test-queue', async (job) => job.data.data.value, {
      connection: queue.opts.connection,
      prefix: TEST_PREFIX,
    });

    const jobData: TestJobData = {
      type: 'TEST',
      timestamp: new Date(),
      data: { value: 'event-test' },
    };

    await queue.add('event-test', serializeJobData(jobData));

    // Wait for all events to be received
    await allEventsReceived;

    expect(events).toContain('waiting');
    expect(events).toContain('active');
    expect(events).toContain('completed');

    await queueEvents.close();
  });
});
