import { Job, Queue } from 'bullmq';
import * as E from 'fp-ts/Either';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { mock } from 'jest-mock-extended';

// Mock types and interfaces
interface JobOptions {
  forceUpdate?: boolean;
  validateOnly?: boolean;
  targetIds?: number[];
}

interface MetaJobData {
  type: string;
  timestamp: Date;
  data: {
    operation: 'UPDATE' | 'SYNC' | 'DELETE' | string;
    id?: number;
    options?: JobOptions;
  };
}

interface MetaQueueService {
  addBootstrapJob: (data: { data: MetaJobData['data'] }) => TE.TaskEither<Error, Job<MetaJobData>>;
  addPhasesJob: (data: { data: MetaJobData['data'] }) => TE.TaskEither<Error, Job<MetaJobData>>;
  getPendingJobs: () => TE.TaskEither<Error, Job<MetaJobData>[]>;
  getFailedJobs: () => TE.TaskEither<Error, Job<MetaJobData>[]>;
  getCompletedJobs: () => TE.TaskEither<Error, Job<MetaJobData>[]>;
  removeJob: (jobId: string) => TE.TaskEither<Error, void>;
  retryJob: (jobId: string) => TE.TaskEither<Error, void>;
}

class MetaQueueServiceImpl implements MetaQueueService {
  constructor(private readonly queue: Queue<MetaJobData>) {}

  addBootstrapJob = (data: { data: MetaJobData['data'] }): TE.TaskEither<Error, Job<MetaJobData>> =>
    pipe(
      TE.tryCatch(
        () =>
          this.queue.add('bootstrap', {
            type: 'BOOTSTRAP',
            timestamp: new Date(),
            data: data.data,
          }),
        (error) => new Error(`Failed to add bootstrap job: ${error}`),
      ),
    );

  addPhasesJob = (data: { data: MetaJobData['data'] }): TE.TaskEither<Error, Job<MetaJobData>> =>
    pipe(
      TE.tryCatch(
        () =>
          this.queue.add('phases', {
            type: 'PHASES',
            timestamp: new Date(),
            data: data.data,
          }),
        (error) => new Error(`Failed to add phases job: ${error}`),
      ),
    );

  getPendingJobs = (): TE.TaskEither<Error, Job<MetaJobData>[]> =>
    pipe(
      TE.tryCatch(
        () => this.queue.getWaiting(),
        (error) => new Error(`Failed to get pending jobs: ${error}`),
      ),
    );

  getFailedJobs = (): TE.TaskEither<Error, Job<MetaJobData>[]> =>
    pipe(
      TE.tryCatch(
        () => this.queue.getFailed(),
        (error) => new Error(`Failed to get failed jobs: ${error}`),
      ),
    );

  getCompletedJobs = (): TE.TaskEither<Error, Job<MetaJobData>[]> =>
    pipe(
      TE.tryCatch(
        () => this.queue.getCompleted(),
        (error) => new Error(`Failed to get completed jobs: ${error}`),
      ),
    );

  removeJob = (jobId: string): TE.TaskEither<Error, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const job = await this.queue.getJob(jobId);
          if (!job) {
            throw new Error(`Job not found: ${jobId}`);
          }
          await job.remove();
        },
        (error) => new Error(`Failed to remove job: ${error}`),
      ),
    );

  retryJob = (jobId: string): TE.TaskEither<Error, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const job = await this.queue.getJob(jobId);
          if (!job) {
            throw new Error(`Job not found: ${jobId}`);
          }
          await job.retry();
        },
        (error) => new Error(`Failed to retry job: ${error}`),
      ),
    );
}

describe('MetaQueueService', () => {
  let mockQueue: jest.Mocked<Queue<MetaJobData>>;
  let metaQueueService: MetaQueueService;
  let mockJob: jest.Mocked<Job<MetaJobData>>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQueue = mock<Queue<MetaJobData>>();
    mockJob = mock<Job<MetaJobData>>();
    metaQueueService = new MetaQueueServiceImpl(mockQueue);
  });

  describe('addBootstrapJob', () => {
    it('should successfully add a bootstrap job', async () => {
      const jobData = {
        data: {
          operation: 'UPDATE' as const,
          id: 1,
          options: { forceUpdate: true },
        },
      };

      mockQueue.add.mockResolvedValue(mockJob);

      const result = await pipe(
        metaQueueService.addBootstrapJob(jobData),
        TE.fold(
          (e) => T.of(E.left(e)),
          (job) => T.of(E.right(job)),
        ),
      )();

      expect(E.isRight(result)).toBe(true);
      expect(mockQueue.add).toHaveBeenCalledWith(
        'bootstrap',
        expect.objectContaining({
          type: 'BOOTSTRAP',
          data: jobData.data,
        }),
      );
    });

    it('should handle queue errors', async () => {
      const jobData = {
        data: {
          operation: 'UPDATE' as const,
          id: 1,
        },
      };

      mockQueue.add.mockRejectedValue(new Error('Queue error'));

      const result = await pipe(
        metaQueueService.addBootstrapJob(jobData),
        TE.fold(
          (e) => T.of(E.left(e)),
          (job) => T.of(E.right(job)),
        ),
      )();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.message).toContain('Failed to add bootstrap job');
      }
    });
  });

  describe('addPhasesJob', () => {
    it('should successfully add a phases job', async () => {
      const jobData = {
        data: {
          operation: 'DELETE' as const,
          id: 1,
        },
      };

      mockQueue.add.mockResolvedValue(mockJob);

      const result = await pipe(
        metaQueueService.addPhasesJob(jobData),
        TE.fold(
          (e) => T.of(E.left(e)),
          (job) => T.of(E.right(job)),
        ),
      )();

      expect(E.isRight(result)).toBe(true);
      expect(mockQueue.add).toHaveBeenCalledWith(
        'phases',
        expect.objectContaining({
          type: 'PHASES',
          data: jobData.data,
        }),
      );
    });

    it('should handle queue errors', async () => {
      const jobData = {
        data: {
          operation: 'DELETE' as const,
          id: 1,
        },
      };

      mockQueue.add.mockRejectedValue(new Error('Queue error'));

      const result = await pipe(
        metaQueueService.addPhasesJob(jobData),
        TE.fold(
          (e) => T.of(E.left(e)),
          (job) => T.of(E.right(job)),
        ),
      )();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.message).toContain('Failed to add phases job');
      }
    });
  });

  describe('job management', () => {
    const mockJobs = [mockJob];

    describe('getPendingJobs', () => {
      it('should return pending jobs', async () => {
        mockQueue.getWaiting.mockResolvedValue(mockJobs);

        const result = await pipe(
          metaQueueService.getPendingJobs(),
          TE.fold(
            (e) => T.of(E.left(e)),
            (jobs) => T.of(E.right(jobs)),
          ),
        )();

        expect(E.isRight(result)).toBe(true);
        expect(mockQueue.getWaiting).toHaveBeenCalled();
      });

      it('should handle queue errors', async () => {
        mockQueue.getWaiting.mockRejectedValue(new Error('Queue error'));

        const result = await pipe(
          metaQueueService.getPendingJobs(),
          TE.fold(
            (e) => T.of(E.left(e)),
            (jobs) => T.of(E.right(jobs)),
          ),
        )();

        expect(E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          expect(result.left.message).toContain('Failed to get pending jobs');
        }
      });
    });

    describe('getFailedJobs', () => {
      it('should return failed jobs', async () => {
        mockQueue.getFailed.mockResolvedValue(mockJobs);

        const result = await pipe(
          metaQueueService.getFailedJobs(),
          TE.fold(
            (e) => T.of(E.left(e)),
            (jobs) => T.of(E.right(jobs)),
          ),
        )();

        expect(E.isRight(result)).toBe(true);
        expect(mockQueue.getFailed).toHaveBeenCalled();
      });

      it('should handle queue errors', async () => {
        mockQueue.getFailed.mockRejectedValue(new Error('Queue error'));

        const result = await pipe(
          metaQueueService.getFailedJobs(),
          TE.fold(
            (e) => T.of(E.left(e)),
            (jobs) => T.of(E.right(jobs)),
          ),
        )();

        expect(E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          expect(result.left.message).toContain('Failed to get failed jobs');
        }
      });
    });

    describe('getCompletedJobs', () => {
      it('should return completed jobs', async () => {
        mockQueue.getCompleted.mockResolvedValue(mockJobs);

        const result = await pipe(
          metaQueueService.getCompletedJobs(),
          TE.fold(
            (e) => T.of(E.left(e)),
            (jobs) => T.of(E.right(jobs)),
          ),
        )();

        expect(E.isRight(result)).toBe(true);
        expect(mockQueue.getCompleted).toHaveBeenCalled();
      });

      it('should handle queue errors', async () => {
        mockQueue.getCompleted.mockRejectedValue(new Error('Queue error'));

        const result = await pipe(
          metaQueueService.getCompletedJobs(),
          TE.fold(
            (e) => T.of(E.left(e)),
            (jobs) => T.of(E.right(jobs)),
          ),
        )();

        expect(E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          expect(result.left.message).toContain('Failed to get completed jobs');
        }
      });
    });

    describe('removeJob', () => {
      it('should successfully remove a job', async () => {
        mockQueue.getJob.mockResolvedValue(mockJob);
        mockJob.remove.mockResolvedValue();

        const result = await pipe(
          metaQueueService.removeJob('job-1'),
          TE.fold(
            (e) => T.of(E.left(e)),
            () => T.of(E.right(undefined)),
          ),
        )();

        expect(E.isRight(result)).toBe(true);
        expect(mockQueue.getJob).toHaveBeenCalledWith('job-1');
        expect(mockJob.remove).toHaveBeenCalled();
      });

      it('should handle non-existent job', async () => {
        mockQueue.getJob.mockResolvedValue(undefined);

        const result = await pipe(
          metaQueueService.removeJob('job-1'),
          TE.fold(
            (e) => T.of(E.left(e)),
            () => T.of(E.right(undefined)),
          ),
        )();

        expect(E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          expect(result.left.message).toContain('Job not found');
        }
      });

      it('should handle queue errors', async () => {
        mockQueue.getJob.mockRejectedValue(new Error('Queue error'));

        const result = await pipe(
          metaQueueService.removeJob('job-1'),
          TE.fold(
            (e) => T.of(E.left(e)),
            () => T.of(E.right(undefined)),
          ),
        )();

        expect(E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          expect(result.left.message).toContain('Failed to remove job');
        }
      });
    });

    describe('retryJob', () => {
      it('should successfully retry a job', async () => {
        mockQueue.getJob.mockResolvedValue(mockJob);
        mockJob.retry.mockResolvedValue();

        const result = await pipe(
          metaQueueService.retryJob('job-1'),
          TE.fold(
            (e) => T.of(E.left(e)),
            () => T.of(E.right(undefined)),
          ),
        )();

        expect(E.isRight(result)).toBe(true);
        expect(mockQueue.getJob).toHaveBeenCalledWith('job-1');
        expect(mockJob.retry).toHaveBeenCalled();
      });

      it('should handle non-existent job', async () => {
        mockQueue.getJob.mockResolvedValue(undefined);

        const result = await pipe(
          metaQueueService.retryJob('job-1'),
          TE.fold(
            (e) => T.of(E.left(e)),
            () => T.of(E.right(undefined)),
          ),
        )();

        expect(E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          expect(result.left.message).toContain('Job not found');
        }
      });

      it('should handle queue errors', async () => {
        mockQueue.getJob.mockRejectedValue(new Error('Queue error'));

        const result = await pipe(
          metaQueueService.retryJob('job-1'),
          TE.fold(
            (e) => T.of(E.left(e)),
            () => T.of(E.right(undefined)),
          ),
        )();

        expect(E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          expect(result.left.message).toContain('Failed to retry job');
        }
      });
    });
  });
});
