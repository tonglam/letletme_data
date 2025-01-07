import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { createPhaseRepository } from '../../src/domain/phase/repository';
import { PhaseId, PhaseResponse } from '../../src/domain/phase/types';
import { DBErrorCode } from '../../src/types/error.type';
import { getTestPhase, getTestPhases } from '../data/bootstrap.test';
import { prisma } from '../setup';

describe('Phase Repository', () => {
  const phaseRepository = createPhaseRepository(prisma);

  beforeEach(async () => {
    await prisma.phase.deleteMany();
  });

  describe('findAll', () => {
    it('should return all phases', async () => {
      // Create test phases using real data
      const phases = getTestPhases().slice(0, 3);
      await Promise.all(
        phases.map((phase: PhaseResponse) =>
          prisma.phase.create({
            data: {
              id: phase.id,
              name: phase.name,
              startEvent: phase.start_event,
              stopEvent: phase.stop_event,
              highestScore: phase.highest_score,
            },
          }),
        ),
      );

      const result = await phaseRepository.findAll()();
      expect(E.isRight(result)).toBe(true);
      pipe(
        result,
        E.map((foundPhases) => {
          expect(foundPhases).toHaveLength(3);
          expect(foundPhases[0]).toHaveProperty('id', phases[0].id);
          expect(foundPhases[0]).toHaveProperty('name', phases[0].name);
        }),
      );
    });

    it('should return empty array when no phases exist', async () => {
      const result = await phaseRepository.findAll()();
      expect(E.isRight(result)).toBe(true);
      pipe(
        result,
        E.map((phases) => {
          expect(phases).toHaveLength(0);
        }),
      );
    });

    it('should handle database errors', async () => {
      await prisma.$disconnect();

      const result = await phaseRepository.findAll()();
      expect(E.isLeft(result)).toBe(true);
      pipe(
        result,
        E.mapLeft((error) => {
          expect(error.code).toBe(DBErrorCode.QUERY_ERROR);
          expect(error.message).toContain('Failed to fetch all phases');
        }),
      );

      await prisma.$connect();
    });
  });

  describe('findById', () => {
    it('should return phase by ID', async () => {
      const phase = getTestPhase(1)!;
      await prisma.phase.create({
        data: {
          id: phase.id,
          name: phase.name,
          startEvent: phase.start_event,
          stopEvent: phase.stop_event,
          highestScore: phase.highest_score,
        },
      });

      const result = await phaseRepository.findById(phase.id as PhaseId)();
      expect(E.isRight(result)).toBe(true);
      pipe(
        result,
        E.map((foundPhase) => {
          expect(foundPhase).not.toBeNull();
          expect(foundPhase?.id).toBe(phase.id);
          expect(foundPhase?.name).toBe(phase.name);
        }),
      );
    });

    it('should return null for non-existent ID', async () => {
      const result = await phaseRepository.findById(999 as PhaseId)();
      expect(E.isRight(result)).toBe(true);
      pipe(
        result,
        E.map((phase) => {
          expect(phase).toBeNull();
        }),
      );
    });

    it('should handle database errors', async () => {
      await prisma.$disconnect();

      const result = await phaseRepository.findById(1 as PhaseId)();
      expect(E.isLeft(result)).toBe(true);
      pipe(
        result,
        E.mapLeft((error) => {
          expect(error.code).toBe(DBErrorCode.QUERY_ERROR);
          expect(error.message).toContain('Failed to fetch phase by id');
        }),
      );

      await prisma.$connect();
    });
  });

  describe('saveBatch', () => {
    it('should save multiple phases', async () => {
      const phases = getTestPhases().slice(0, 3);
      const phaseData = phases.map((phase: PhaseResponse) => ({
        id: phase.id,
        name: phase.name,
        startEvent: phase.start_event,
        stopEvent: phase.stop_event,
        highestScore: phase.highest_score,
      }));

      const result = await phaseRepository.saveBatch(phaseData)();
      expect(E.isRight(result)).toBe(true);
      pipe(
        result,
        E.map((savedPhases) => {
          expect(savedPhases).toHaveLength(3);
          expect(savedPhases[0]).toHaveProperty('id', phases[0].id);
          expect(savedPhases[0]).toHaveProperty('name', phases[0].name);
        }),
      );
    });

    it('should handle duplicate IDs gracefully', async () => {
      const phase = getTestPhase(1)!;
      await prisma.phase.create({
        data: {
          id: phase.id,
          name: phase.name,
          startEvent: phase.start_event,
          stopEvent: phase.stop_event,
          highestScore: phase.highest_score,
        },
      });

      const phases = [phase, getTestPhase(2)!];
      const phaseData = phases.map((p: PhaseResponse) => ({
        id: p.id,
        name: p.name,
        startEvent: p.start_event,
        stopEvent: p.stop_event,
        highestScore: p.highest_score,
      }));

      const result = await phaseRepository.saveBatch(phaseData)();
      expect(E.isRight(result)).toBe(true);
      pipe(
        result,
        E.map((savedPhases) => {
          expect(savedPhases).toHaveLength(2);
        }),
      );
    });

    it('should handle database errors', async () => {
      await prisma.$disconnect();

      const phases = getTestPhases().slice(0, 3);
      const phaseData = phases.map((phase: PhaseResponse) => ({
        id: phase.id,
        name: phase.name,
        startEvent: phase.start_event,
        stopEvent: phase.stop_event,
        highestScore: phase.highest_score,
      }));

      const result = await phaseRepository.saveBatch(phaseData)();
      expect(E.isLeft(result)).toBe(true);
      pipe(
        result,
        E.mapLeft((error) => {
          expect(error.code).toBe(DBErrorCode.QUERY_ERROR);
          expect(error.message).toContain('Failed to create phases in batch');
        }),
      );

      await prisma.$connect();
    });
  });

  describe('deleteAll', () => {
    it('should delete all phases', async () => {
      const phases = getTestPhases().slice(0, 3);
      await Promise.all(
        phases.map((phase: PhaseResponse) =>
          prisma.phase.create({
            data: {
              id: phase.id,
              name: phase.name,
              startEvent: phase.start_event,
              stopEvent: phase.stop_event,
              highestScore: phase.highest_score,
            },
          }),
        ),
      );

      const result = await phaseRepository.deleteAll()();
      expect(E.isRight(result)).toBe(true);

      const count = await prisma.phase.count();
      expect(count).toBe(0);
    });

    it('should handle database errors', async () => {
      await prisma.$disconnect();

      const result = await phaseRepository.deleteAll()();
      expect(E.isLeft(result)).toBe(true);
      pipe(
        result,
        E.mapLeft((error) => {
          expect(error.code).toBe(DBErrorCode.QUERY_ERROR);
          expect(error.message).toContain('Failed to delete all phases');
        }),
      );

      await prisma.$connect();
    });
  });
});
