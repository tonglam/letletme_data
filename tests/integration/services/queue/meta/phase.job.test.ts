import { Job } from 'bullmq';
import * as E from 'fp-ts/Either';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { phaseRepository } from '../../../../../src/domains/phases/repository';
import {
  APIError,
  createInternalServerError,
} from '../../../../../src/infrastructure/api/common/errors';
import { createFPLClient, FPLClient } from '../../../../../src/infrastructure/api/fpl';
import { MetaJobData } from '../../../../../src/infrastructure/queue/core/types';
import {
  createMetaQueueService,
  MetaQueueService,
} from '../../../../../src/infrastructure/queue/meta/meta.queue';
import { PhaseJobService } from '../../../../../src/services/queue/meta/phase.job';
import { PhaseId, PrismaPhase, validatePhaseId } from '../../../../../src/types/phase.type';

const toAPIError = (error: Error): APIError =>
  createInternalServerError({ message: error.message });

describe('PhaseJobService Integration', () => {
  let phaseJobService: PhaseJobService;
  let fplClient: FPLClient;
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

    // Create FPL client for real data
    const clientResult = await createFPLClient()();
    if (E.isLeft(clientResult)) {
      throw clientResult.left;
    }
    fplClient = clientResult.right;
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
      const bootstrapResult = await fplClient.getBootstrapStatic();
      expect(E.isRight(bootstrapResult)).toBe(true);

      if (E.isRight(bootstrapResult)) {
        const { events } = bootstrapResult.right;
        expect(events.length).toBeGreaterThan(0);

        // Convert FPL events to phases
        const phaseData = events.map((event, index) => ({
          id: index + 1,
          name: `Gameweek ${event.id}`,
          startEvent: event.id,
          stopEvent: event.id,
          highestScore: null,
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
          phaseJobService.processPhaseJob(syncJobResult),
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

    it('should handle phase deletion workflow', async () => {
      // Get all phases
      const phasesResult = await pipe(
        phaseJobService['phaseRepo'].findAll(),
        TE.fold(
          (error: APIError) => T.of(Promise.reject(error)),
          (phases: PrismaPhase[]) => T.of(Promise.resolve(phases)),
        ),
      )();

      expect(phasesResult.length).toBeGreaterThan(0);
      const phaseToDelete = phasesResult[0];
      const phaseId = pipe(
        validatePhaseId(phaseToDelete.id),
        E.getOrElseW((error: string) => {
          throw new Error(error);
        }),
      );

      // Schedule deletion job
      const deleteJobResult = await pipe(
        phaseJobService.schedulePhaseDelete(phaseId),
        TE.mapLeft(toAPIError),
        TE.fold(
          (error: APIError) => T.of(Promise.reject(error)),
          (job: Job<MetaJobData>) => T.of(Promise.resolve(job)),
        ),
      )();

      expect(deleteJobResult).toBeDefined();
      expect(deleteJobResult.data.type).toBe('PHASES');
      expect(deleteJobResult.data.data.operation).toBe('DELETE');

      // Process deletion job
      const processResult = await pipe(
        phaseJobService.processPhaseJob(deleteJobResult),
        TE.mapLeft(toAPIError),
        TE.fold(
          (error: APIError) => T.of(Promise.reject(error)),
          () => T.of(Promise.resolve(undefined)),
        ),
      )();

      expect(processResult).toBeUndefined();

      // Verify phase was deleted
      const verifyResult = await pipe(
        phaseJobService['phaseRepo'].findById(phaseId),
        TE.fold(
          (error: APIError) => T.of(Promise.reject(error)),
          (phase: PrismaPhase | null) => T.of(Promise.resolve(phase)),
        ),
      )();

      expect(verifyResult).toBeNull();
    });
  });
});
