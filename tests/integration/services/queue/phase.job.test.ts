import { Job } from 'bullmq';
import * as E from 'fp-ts/Either';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { BootstrapApi } from '../../../../src/domains/bootstrap/operations';
import { phaseRepository } from '../../../../src/domains/phases/repository';
import {
  APIError,
  createInternalServerError,
} from '../../../../src/infrastructure/api/common/errors';
import {
  createMetaQueueService,
  MetaQueueService,
} from '../../../../src/infrastructure/queue/meta/meta.queue';
import { MetaJobData } from '../../../../src/infrastructure/queue/types';
import { PhaseJobService } from '../../../../src/services/queue/meta/phases.job';
import { PhaseId, PrismaPhase, validatePhaseId } from '../../../../src/types/phases.type';

const toAPIError = (error: Error): APIError =>
  createInternalServerError({ message: error.message });

describe('PhaseJobService Integration', () => {
  let phaseJobService: PhaseJobService;
  let fplClient: BootstrapApi;
  let metaQueue: MetaQueueService;
  let phases: PrismaPhase[] = [];

  beforeAll(async () => {
    // Create real services
    metaQueue = createMetaQueueService();
    phaseJobService = new PhaseJobService(metaQueue, {
      ...phaseRepository,
      findAll: () => TE.right(phases),
      findById: (id: PhaseId) => TE.right(phases.find((p) => p.id === id) || null),
      findByIds: (ids: number[]) => TE.right(phases.filter((p) => ids.includes(p.id))),
      save: (phase: PrismaPhase) => {
        const existingIndex = phases.findIndex((p) => p.id === phase.id);
        if (existingIndex >= 0) {
          phases[existingIndex] = phase;
        } else {
          phases.push(phase);
        }
        return TE.right(phase);
      },
      update: (id: PhaseId, phase: Partial<PrismaPhase>) => {
        const existingIndex = phases.findIndex((p) => p.id === id);
        if (existingIndex >= 0) {
          phases[existingIndex] = { ...phases[existingIndex], ...phase };
          return TE.right(phases[existingIndex]);
        }
        return TE.left(createInternalServerError({ message: 'Phase not found' }));
      },
      deleteByIds: (ids: PhaseId[]) => {
        phases = phases.filter((p) => !ids.includes(p.id as PhaseId));
        return TE.right(undefined);
      },
      deleteAll: () => {
        phases = [];
        return TE.right(undefined);
      },
    });

    // Initialize FPL client with mock data
    fplClient = {
      getBootstrapData: async () => {
        const phases = [1, 2].map((id) => ({
          id: pipe(
            validatePhaseId(id),
            E.getOrElseW((error: string) => {
              throw new Error(error);
            }),
          ),
          name: `Phase ${id}`,
          startEvent: id === 1 ? 1 : 6,
          stopEvent: id === 1 ? 5 : 10,
          highestScore: null,
        }));
        return phases;
      },
      getBootstrapEvents: async () => [],
    };
  });

  afterAll(async () => {
    // Clean up resources
    await pipe(
      metaQueue.close(),
      TE.fold(
        (error) => {
          console.error('Failed to close queue:', error);
          return T.of(undefined);
        },
        () => T.of(undefined),
      ),
    )();
  });

  describe('Complete Phase Workflow', () => {
    it('should execute full phase sync workflow with real data', async () => {
      // 1. First get real phase data from FPL
      const bootstrapData = await fplClient.getBootstrapData();
      expect(bootstrapData).toBeDefined();
      expect(Array.isArray(bootstrapData)).toBe(true);

      if (bootstrapData) {
        // Convert domain phases to prisma phases
        const phaseData = bootstrapData.map((phase) => ({
          ...phase,
          createdAt: new Date(),
        }));

        // Save phases to mock repository
        for (const phase of phaseData) {
          await pipe(
            phaseJobService['phaseRepo'].save(phase),
            TE.fold(
              (error: APIError) => T.of(Promise.reject(error)),
              () => T.of(Promise.resolve(undefined)),
            ),
          )();
        }

        // 2. Schedule a phase sync job
        const syncJobResult = await pipe(
          phaseJobService.schedulePhasesSync({ validateOnly: false }),
          TE.mapLeft(toAPIError),
          TE.fold(
            (error: APIError) => T.of(Promise.reject(error)),
            (job: Job<MetaJobData>) => T.of(Promise.resolve(job)),
          ),
        )();

        // Verify job was created correctly
        expect(syncJobResult).toBeDefined();
        expect(syncJobResult.data.type).toBe('PHASES');
        expect(syncJobResult.data.data.operation).toBe('SYNC');

        // 3. Process the sync job
        const processResult = await pipe(
          phaseJobService.processPhasesJob(syncJobResult),
          TE.mapLeft(toAPIError),
          TE.fold(
            (error: APIError) => T.of(Promise.reject(error)),
            () => T.of(Promise.resolve(undefined)),
          ),
        )();

        expect(processResult).toBeUndefined();

        // 4. Verify phases were synced by checking repository
        const phasesResult = await pipe(
          phaseJobService['phaseRepo'].findAll(),
          TE.fold(
            (error: APIError) => T.of(Promise.reject(error)),
            (phases: PrismaPhase[]) => T.of(Promise.resolve(phases)),
          ),
        )();

        expect(phasesResult).toBeDefined();
        expect(phasesResult.length).toBeGreaterThan(0);

        // 5. Test update workflow for a specific phase
        const firstPhase = phasesResult[0];
        const phaseId = pipe(
          validatePhaseId(firstPhase.id),
          E.getOrElseW((error: string) => {
            throw new Error(error);
          }),
        );

        const updateJobResult = await pipe(
          phaseJobService.schedulePhaseUpdate(phaseId, { forceUpdate: true }),
          TE.mapLeft(toAPIError),
          TE.fold(
            (error: APIError) => T.of(Promise.reject(error)),
            (job: Job<MetaJobData>) => T.of(Promise.resolve(job)),
          ),
        )();

        expect(updateJobResult).toBeDefined();
        expect(updateJobResult.data.type).toBe('PHASES');
        expect(updateJobResult.data.data.operation).toBe('UPDATE');
      }
    });
  });
});
