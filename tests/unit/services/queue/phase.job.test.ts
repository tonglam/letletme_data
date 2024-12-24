import { Job } from 'bullmq';
import * as E from 'fp-ts/Either';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { DeepMockProxy, mock } from 'jest-mock-extended';

// Mock types and interfaces
type PhaseId = number;

interface PrismaPhase {
  id: number;
  name: string;
  startEvent: number;
  stopEvent: number;
  createdAt: Date;
  updatedAt: Date;
}

interface PrismaPhaseCreate extends Partial<PrismaPhase> {}

interface PhaseRepository {
  findById: (id: PhaseId) => TE.TaskEither<Error, PrismaPhase | null>;
  findByIds: (ids: PhaseId[]) => TE.TaskEither<Error, PrismaPhase[]>;
  findAll: () => TE.TaskEither<Error, PrismaPhase[]>;
  update: (id: PhaseId, phase: PrismaPhaseCreate) => TE.TaskEither<Error, PrismaPhase>;
  deleteByIds: (ids: PhaseId[]) => TE.TaskEither<Error, void>;
}

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
  addPhasesJob: (data: { data: MetaJobData['data'] }) => TE.TaskEither<Error, Job<MetaJobData>>;
}

class PhaseJobService {
  constructor(
    private readonly metaQueue: MetaQueueService,
    private readonly phaseRepo: PhaseRepository,
  ) {}

  processPhaseJob = (job: Job<MetaJobData>): TE.TaskEither<Error, void> => {
    const { operation, id, options } = job.data.data;

    switch (operation) {
      case 'UPDATE':
        return this.handlePhaseUpdate(id, options);
      case 'SYNC':
        return this.handlePhaseSync(options);
      case 'DELETE':
        return this.handlePhaseDelete(id);
      default:
        return TE.left(new Error(`Unknown phase operation: ${operation}`));
    }
  };

  private handlePhaseUpdate = (id?: number, options?: JobOptions): TE.TaskEither<Error, void> =>
    pipe(
      TE.fromNullable(new Error('Phase ID is required for update operation'))(id),
      TE.chain((phaseId) =>
        pipe(
          this.phaseRepo.findById(phaseId),
          TE.chain((phase) =>
            phase
              ? pipe(
                  this.phaseRepo.update(phase.id, {
                    ...phase,
                    id: phase.id,
                    ...(options?.forceUpdate && { forceUpdate: options.forceUpdate }),
                  }),
                  TE.map(() => undefined),
                )
              : TE.left(new Error(`Phase not found: ${phaseId}`)),
          ),
        ),
      ),
    );

  private handlePhaseSync = (options?: JobOptions): TE.TaskEither<Error, void> =>
    pipe(
      options?.targetIds ? this.phaseRepo.findByIds(options.targetIds) : this.phaseRepo.findAll(),
      TE.chain((phases) =>
        pipe(
          phases,
          TE.traverseArray((phase) =>
            pipe(
              this.phaseRepo.update(phase.id, {
                ...phase,
                id: phase.id,
                ...(options?.forceUpdate && { forceUpdate: options.forceUpdate }),
                ...(options?.validateOnly && { validateOnly: options.validateOnly }),
              }),
            ),
          ),
          TE.map(() => undefined),
        ),
      ),
    );

  private handlePhaseDelete = (id?: number): TE.TaskEither<Error, void> =>
    pipe(
      TE.fromNullable(new Error('Phase ID is required for delete operation'))(id),
      TE.chain((phaseId) => this.phaseRepo.deleteByIds([phaseId])),
    );

  schedulePhaseUpdate = (
    id: number,
    options?: Pick<JobOptions, 'forceUpdate'>,
  ): TE.TaskEither<Error, Job<MetaJobData>> =>
    this.metaQueue.addPhasesJob({
      data: {
        operation: 'UPDATE',
        id,
        options,
      },
    });

  schedulePhasesSync = (options?: JobOptions): TE.TaskEither<Error, Job<MetaJobData>> =>
    this.metaQueue.addPhasesJob({
      data: {
        operation: 'SYNC',
        options,
      },
    });

  schedulePhaseDelete = (id: number): TE.TaskEither<Error, Job<MetaJobData>> =>
    this.metaQueue.addPhasesJob({
      data: {
        operation: 'DELETE',
        id,
      },
    });
}

describe('PhaseJobService', () => {
  let mockMetaQueue: DeepMockProxy<MetaQueueService>;
  let mockPhaseRepo: DeepMockProxy<PhaseRepository>;
  let phaseJobService: PhaseJobService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockMetaQueue = mock<MetaQueueService>();
    mockPhaseRepo = mock<PhaseRepository>();
    phaseJobService = new PhaseJobService(mockMetaQueue, mockPhaseRepo);
  });

  describe('processPhaseJob', () => {
    const mockJob = mock<Job<MetaJobData>>();

    describe('UPDATE operation', () => {
      const mockPhase: PrismaPhase = {
        id: 1,
        name: 'Test Phase',
        startEvent: 1,
        stopEvent: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      beforeEach(() => {
        mockJob.data = {
          type: 'PHASES',
          timestamp: new Date(),
          data: {
            operation: 'UPDATE',
            id: 1,
            options: { forceUpdate: true },
          },
        };
      });

      it('should successfully process an update operation', async () => {
        mockPhaseRepo.findById.mockReturnValue(TE.right(mockPhase));
        mockPhaseRepo.update.mockReturnValue(TE.right(mockPhase));

        const result = await pipe(
          phaseJobService.processPhaseJob(mockJob),
          TE.fold(
            (e) => T.of(E.left(e)),
            () => T.of(E.right(undefined)),
          ),
        )();

        expect(E.isRight(result)).toBe(true);
        expect(mockPhaseRepo.findById).toHaveBeenCalledWith(1);
        expect(mockPhaseRepo.update).toHaveBeenCalledWith(
          1,
          expect.objectContaining({
            id: 1,
            forceUpdate: true,
          }),
        );
      });

      it('should handle non-existent phase', async () => {
        mockPhaseRepo.findById.mockReturnValue(TE.right(null));

        const result = await pipe(
          phaseJobService.processPhaseJob(mockJob),
          TE.fold(
            (e) => T.of(E.left(e)),
            () => T.of(E.right(undefined)),
          ),
        )();

        expect(E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          expect(result.left.message).toContain('Phase not found');
        }
      });

      it('should handle API errors', async () => {
        const error = new Error('API Error');
        mockPhaseRepo.findById.mockReturnValue(TE.left(error));

        const result = await pipe(
          phaseJobService.processPhaseJob(mockJob),
          TE.fold(
            (e) => T.of(E.left(e)),
            () => T.of(E.right(undefined)),
          ),
        )();

        expect(E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          const error = result.left as Error;
          expect(error.message).toBe('API Error');
        }
      });
    });

    describe('SYNC operation', () => {
      const mockPhases: PrismaPhase[] = [
        {
          id: 1,
          name: 'Phase 1',
          startEvent: 1,
          stopEvent: 2,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 2,
          name: 'Phase 2',
          startEvent: 3,
          stopEvent: 4,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      beforeEach(() => {
        mockJob.data = {
          type: 'PHASES',
          timestamp: new Date(),
          data: {
            operation: 'SYNC',
            options: { forceUpdate: true },
          },
        };
      });

      it('should successfully sync all phases', async () => {
        mockPhaseRepo.findAll.mockReturnValue(TE.right(mockPhases));
        mockPhaseRepo.update.mockReturnValue(TE.right(mockPhases[0]));

        const result = await pipe(
          phaseJobService.processPhaseJob(mockJob),
          TE.fold(
            (e) => T.of(E.left(e)),
            () => T.of(E.right(undefined)),
          ),
        )();

        expect(E.isRight(result)).toBe(true);
        expect(mockPhaseRepo.findAll).toHaveBeenCalled();
        expect(mockPhaseRepo.update).toHaveBeenCalledTimes(2);
      });

      it('should sync specific phases when targetIds are provided', async () => {
        mockJob.data = {
          ...mockJob.data,
          data: {
            operation: 'SYNC',
            options: { targetIds: [1, 2] },
          },
        };

        mockPhaseRepo.findByIds.mockReturnValue(TE.right(mockPhases));
        mockPhaseRepo.update.mockReturnValue(TE.right(mockPhases[0]));

        const result = await pipe(
          phaseJobService.processPhaseJob(mockJob),
          TE.fold(
            (e) => T.of(E.left(e)),
            () => T.of(E.right(undefined)),
          ),
        )();

        expect(E.isRight(result)).toBe(true);
        expect(mockPhaseRepo.findByIds).toHaveBeenCalledWith([1, 2] as PhaseId[]);
        expect(mockPhaseRepo.update).toHaveBeenCalledTimes(2);
      });
    });

    describe('DELETE operation', () => {
      beforeEach(() => {
        mockJob.data = {
          type: 'PHASES',
          timestamp: new Date(),
          data: {
            operation: 'DELETE',
            id: 1,
          },
        };
      });

      it('should successfully delete a phase', async () => {
        mockPhaseRepo.deleteByIds.mockReturnValue(TE.right(undefined));

        const result = await pipe(
          phaseJobService.processPhaseJob(mockJob),
          TE.fold(
            (e) => T.of(E.left(e)),
            () => T.of(E.right(undefined)),
          ),
        )();

        expect(E.isRight(result)).toBe(true);
        expect(mockPhaseRepo.deleteByIds).toHaveBeenCalledWith([1] as PhaseId[]);
      });

      it('should handle missing phase ID', async () => {
        mockJob.data = {
          ...mockJob.data,
          data: {
            operation: 'DELETE',
            id: undefined,
          },
        };

        const result = await pipe(
          phaseJobService.processPhaseJob(mockJob),
          TE.fold(
            (e) => T.of(E.left(e)),
            () => T.of(E.right(undefined)),
          ),
        )();

        expect(E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          const error = result.left as Error;
          expect(error.message).toContain('Phase ID is required');
        }
      });
    });

    describe('Unknown operation', () => {
      it('should handle unknown operations', async () => {
        mockJob.data = {
          type: 'PHASES',
          timestamp: new Date(),
          data: {
            operation: 'INVALID',
            id: 1,
          },
        };

        const result = await pipe(
          phaseJobService.processPhaseJob(mockJob),
          TE.fold(
            (e) => T.of(E.left(e)),
            () => T.of(E.right(undefined)),
          ),
        )();

        expect(E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          const error = result.left as Error;
          expect(error.message).toContain('Unknown phase operation');
        }
      });
    });
  });

  describe('scheduling', () => {
    const mockJobResult = mock<Job<MetaJobData>>();

    describe('schedulePhaseUpdate', () => {
      it('should schedule a phase update job', async () => {
        mockMetaQueue.addPhasesJob.mockReturnValue(TE.right(mockJobResult));

        const result = await pipe(
          phaseJobService.schedulePhaseUpdate(1, { forceUpdate: true }),
          TE.fold(
            (e) => T.of(E.left(e)),
            (job) => T.of(E.right(job)),
          ),
        )();

        expect(E.isRight(result)).toBe(true);
        expect(mockMetaQueue.addPhasesJob).toHaveBeenCalledWith({
          data: {
            operation: 'UPDATE',
            id: 1,
            options: { forceUpdate: true },
          },
        });
      });
    });

    describe('schedulePhasesSync', () => {
      it('should schedule a phase sync job', async () => {
        const options: JobOptions = { forceUpdate: true, validateOnly: true };
        mockMetaQueue.addPhasesJob.mockReturnValue(TE.right(mockJobResult));

        const result = await pipe(
          phaseJobService.schedulePhasesSync(options),
          TE.fold(
            (e) => T.of(E.left(e)),
            (job) => T.of(E.right(job)),
          ),
        )();

        expect(E.isRight(result)).toBe(true);
        expect(mockMetaQueue.addPhasesJob).toHaveBeenCalledWith({
          data: {
            operation: 'SYNC',
            options,
          },
        });
      });
    });

    describe('schedulePhaseDelete', () => {
      it('should schedule a phase delete job', async () => {
        mockMetaQueue.addPhasesJob.mockReturnValue(TE.right(mockJobResult));

        const result = await pipe(
          phaseJobService.schedulePhaseDelete(1),
          TE.fold(
            (e) => T.of(E.left(e)),
            (job) => T.of(E.right(job)),
          ),
        )();

        expect(E.isRight(result)).toBe(true);
        expect(mockMetaQueue.addPhasesJob).toHaveBeenCalledWith({
          data: {
            operation: 'DELETE',
            id: 1,
          },
        });
      });
    });
  });
});
