import { Job, JobsOptions } from 'bullmq';
import * as E from 'fp-ts/Either';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { BaseJobData, JobCounts, QueueAdapter } from 'infrastructure/queue';
import { mock } from 'jest-mock-extended';
import { QueueService, createQueueService } from 'src/services/queue/queue.service';

describe('QueueService', () => {
  // Test data and setup
  const mockJobData: BaseJobData = {
    type: 'TEST_JOB',
    timestamp: new Date(),
    priority: 1,
  };

  const mockJob = mock<Job<BaseJobData>>();
  const mockAdapter = mock<QueueAdapter<BaseJobData>>();
  let queueService: QueueService<BaseJobData>;

  beforeEach(() => {
    jest.clearAllMocks();
    queueService = createQueueService(mockAdapter);
  });

  describe('add', () => {
    const jobOptions: JobsOptions = { priority: 1 };

    it('should successfully add a job', async () => {
      mockAdapter.add.mockReturnValue(TE.right(mockJob));

      const result = await pipe(
        queueService.add(mockJobData, jobOptions),
        TE.fold(() => T.of(mockJob), T.of),
      )();

      expect(result).toBe(mockJob);
      expect(mockAdapter.add).toHaveBeenCalledWith(mockJobData, jobOptions);
    });

    it('should handle error when adding a job fails', async () => {
      const error = new Error('Failed to add job');
      mockAdapter.add.mockReturnValue(TE.left(error));

      const result = await pipe(
        queueService.add(mockJobData, jobOptions),
        TE.fold(
          (e) => T.of(E.left(e)),
          (job) => T.of(E.right(job)),
        ),
      )();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left).toEqual(error);
      }
    });
  });

  describe('addBulk', () => {
    const jobs = [
      { data: mockJobData, opts: { priority: 1 } },
      { data: { ...mockJobData, priority: 2 }, opts: { priority: 2 } },
    ];

    it('should successfully add bulk jobs', async () => {
      const mockJobs = [mock<Job<BaseJobData>>(), mock<Job<BaseJobData>>()];
      mockAdapter.addBulk.mockReturnValue(TE.right(mockJobs));

      const result = await pipe(
        queueService.addBulk(jobs),
        TE.fold(() => T.of(mockJobs), T.of),
      )();

      expect(result).toBe(mockJobs);
      expect(mockAdapter.addBulk).toHaveBeenCalledWith(jobs);
    });

    it('should handle error when adding bulk jobs fails', async () => {
      const error = new Error('Failed to add bulk jobs');
      mockAdapter.addBulk.mockReturnValue(TE.left(error));

      const result = await pipe(
        queueService.addBulk(jobs),
        TE.fold(
          (e) => T.of(E.left(e)),
          (addedJobs) => T.of(E.right(addedJobs)),
        ),
      )();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left).toEqual(error);
      }
    });
  });

  describe('getJob', () => {
    const jobId = 'test-job-id';

    it('should successfully get a job', async () => {
      mockAdapter.getJob.mockReturnValue(TE.right(mockJob));

      const result = await pipe(
        queueService.getJob(jobId),
        TE.fold(() => T.of(null), T.of),
      )();

      expect(result).toBe(mockJob);
      expect(mockAdapter.getJob).toHaveBeenCalledWith(jobId);
    });

    it('should handle error when getting a job fails', async () => {
      const error = new Error('Failed to get job');
      mockAdapter.getJob.mockReturnValue(TE.left(error));

      const result = await pipe(
        queueService.getJob(jobId),
        TE.fold(
          (e) => T.of(E.left(e)),
          (job) => T.of(E.right(job)),
        ),
      )();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left).toEqual(error);
      }
    });

    it('should handle null job result', async () => {
      mockAdapter.getJob.mockReturnValue(TE.right(null));

      const result = await pipe(
        queueService.getJob(jobId),
        TE.fold(() => T.of(null), T.of),
      )();

      expect(result).toBeNull();
    });
  });

  describe('getJobCounts', () => {
    const mockCounts: JobCounts = {
      waiting: 1,
      active: 2,
      completed: 3,
      failed: 4,
      delayed: 5,
      paused: 6,
    };

    it('should successfully get job counts', async () => {
      mockAdapter.getJobCounts.mockReturnValue(TE.right(mockCounts));

      const result = await pipe(
        queueService.getJobCounts(),
        TE.fold(() => T.of(mockCounts), T.of),
      )();

      expect(result).toBe(mockCounts);
      expect(mockAdapter.getJobCounts).toHaveBeenCalled();
    });

    it('should handle error when getting job counts fails', async () => {
      const error = new Error('Failed to get job counts');
      mockAdapter.getJobCounts.mockReturnValue(TE.left(error));

      const result = await pipe(
        queueService.getJobCounts(),
        TE.fold(
          (e) => T.of(E.left(e)),
          (counts) => T.of(E.right(counts)),
        ),
      )();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left).toEqual(error);
      }
    });
  });

  describe('queue management', () => {
    describe('pause', () => {
      it('should successfully pause the queue', async () => {
        mockAdapter.pause.mockReturnValue(TE.right(undefined));

        await pipe(
          queueService.pause(),
          TE.fold(() => T.of(undefined), T.of),
        )();

        expect(mockAdapter.pause).toHaveBeenCalled();
      });

      it('should handle error when pausing fails', async () => {
        const error = new Error('Failed to pause queue');
        mockAdapter.pause.mockReturnValue(TE.left(error));

        const result = await pipe(
          queueService.pause(),
          TE.fold(
            (e) => T.of(E.left(e)),
            () => T.of(E.right(undefined)),
          ),
        )();

        expect(E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          expect(result.left).toEqual(error);
        }
      });
    });

    describe('resume', () => {
      it('should successfully resume the queue', async () => {
        mockAdapter.resume.mockReturnValue(TE.right(undefined));

        await pipe(
          queueService.resume(),
          TE.fold(() => T.of(undefined), T.of),
        )();

        expect(mockAdapter.resume).toHaveBeenCalled();
      });

      it('should handle error when resuming fails', async () => {
        const error = new Error('Failed to resume queue');
        mockAdapter.resume.mockReturnValue(TE.left(error));

        const result = await pipe(
          queueService.resume(),
          TE.fold(
            (e) => T.of(E.left(e)),
            () => T.of(E.right(undefined)),
          ),
        )();

        expect(E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          expect(result.left).toEqual(error);
        }
      });
    });

    describe('clean', () => {
      const grace = 1000;
      const limit = 100;

      it('should successfully clean the queue', async () => {
        mockAdapter.clean.mockReturnValue(TE.right(10));

        const result = await pipe(
          queueService.clean(grace, limit),
          TE.fold(() => T.of(0), T.of),
        )();

        expect(result).toBe(10);
        expect(mockAdapter.clean).toHaveBeenCalledWith(grace, limit);
      });

      it('should handle error when cleaning fails', async () => {
        const error = new Error('Failed to clean queue');
        mockAdapter.clean.mockReturnValue(TE.left(error));

        const result = await pipe(
          queueService.clean(grace, limit),
          TE.fold(
            (e) => T.of(E.left(e)),
            (count) => T.of(E.right(count)),
          ),
        )();

        expect(E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          expect(result.left).toEqual(error);
        }
      });
    });

    describe('close', () => {
      it('should successfully close the queue', async () => {
        mockAdapter.close.mockReturnValue(TE.right(undefined));

        await pipe(
          queueService.close(),
          TE.fold(() => T.of(undefined), T.of),
        )();

        expect(mockAdapter.close).toHaveBeenCalled();
      });

      it('should handle error when closing fails', async () => {
        const error = new Error('Failed to close queue');
        mockAdapter.close.mockReturnValue(TE.left(error));

        const result = await pipe(
          queueService.close(),
          TE.fold(
            (e) => T.of(E.left(e)),
            () => T.of(E.right(undefined)),
          ),
        )();

        expect(E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          expect(result.left).toEqual(error);
        }
      });
    });
  });
});
