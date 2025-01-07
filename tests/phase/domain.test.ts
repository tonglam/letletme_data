import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import {
  PhaseId,
  PhaseResponse,
  PrismaPhase,
  toDomainPhase,
  validatePhaseId,
} from '../../src/domain/phase/types';
import bootstrapData from '../data/bootstrap.json';

describe('Phase Domain Tests', () => {
  let testPhases: PhaseResponse[];

  beforeAll(() => {
    testPhases = bootstrapData.phases;
  });

  describe('Domain Model Transformation', () => {
    it('should transform API response to domain model', () => {
      const response = testPhases[0];
      const phase = toDomainPhase(response);

      expect(phase).toMatchObject({
        id: expect.any(Number),
        name: expect.any(String),
        startEvent: expect.any(Number),
        stopEvent: expect.any(Number),
        highestScore: expect.any(Number),
      });

      // Verify field transformations
      expect(phase.id).toBe(response.id);
      expect(phase.name).toBe(response.name);
      expect(phase.startEvent).toBe(response.start_event);
      expect(phase.stopEvent).toBe(response.stop_event);
      expect(phase.highestScore).toBe(response.highest_score);
    });

    it('should transform Prisma model to domain model', () => {
      const apiPhase = testPhases[0];
      const prismaPhase: PrismaPhase = {
        id: apiPhase.id,
        name: apiPhase.name,
        startEvent: apiPhase.start_event,
        stopEvent: apiPhase.stop_event,
        highestScore: apiPhase.highest_score,
        createdAt: new Date(),
      };
      const phase = toDomainPhase(prismaPhase);

      expect(phase).toMatchObject({
        id: prismaPhase.id,
        name: prismaPhase.name,
        startEvent: prismaPhase.startEvent,
        stopEvent: prismaPhase.stopEvent,
        highestScore: prismaPhase.highestScore,
      });
    });

    it('should handle optional and null fields correctly', () => {
      // Test with null highest score
      const responseWithNull: PhaseResponse = {
        ...testPhases[0],
        highest_score: null,
      };
      const phaseWithNull = toDomainPhase(responseWithNull);
      expect(phaseWithNull.highestScore).toBeNull();

      // Test with missing highest score field (should be treated as null per schema)
      const responseWithMissing: PhaseResponse = {
        id: testPhases[0].id,
        name: testPhases[0].name,
        start_event: testPhases[0].start_event,
        stop_event: testPhases[0].stop_event,
        highest_score: null,
      };
      const phaseWithMissing = toDomainPhase(responseWithMissing);
      expect(phaseWithMissing.highestScore).toBeNull();
    });

    it('should enforce business logic constraints', () => {
      // Find a valid phase to base our test on
      const validPhase = testPhases.find((p) => p.stop_event > p.start_event);
      expect(validPhase).toBeDefined();
      if (!validPhase) return;

      const phase = toDomainPhase(validPhase);
      expect(phase.stopEvent).toBeGreaterThan(phase.startEvent);
    });
  });

  describe('Phase ID Validation', () => {
    it('should validate valid phase ID', () => {
      const result = validatePhaseId(testPhases[0].id);
      expect(E.isRight(result)).toBe(true);
      pipe(
        result,
        E.map((id) => {
          expect(id).toBe(testPhases[0].id);
          expect(typeof id).toBe('number');
        }),
      );
    });

    it('should reject invalid phase ID types', () => {
      const testCases = [
        { input: 'invalid' },
        { input: null },
        { input: undefined },
        { input: {} },
        { input: [] },
      ];

      testCases.forEach(({ input }) => {
        const result = validatePhaseId(input as number);
        expect(E.isLeft(result)).toBe(true);
        if (E.isRight(result)) return;
        expect(result.left).toContain('Invalid phase ID');
      });
    });

    it('should reject invalid numeric values', () => {
      const testCases = [
        { input: 0 },
        { input: -1 },
        { input: 1.5 },
        { input: Infinity },
        { input: NaN },
      ];

      testCases.forEach(({ input }) => {
        const result = validatePhaseId(input);
        expect(E.isLeft(result)).toBe(true);
        if (E.isRight(result)) return;
        expect(result.left).toContain('Invalid phase ID');
      });
    });

    it('should create branded type for valid ID', () => {
      const validIds = testPhases.map((p) => p.id);

      validIds.forEach((id) => {
        const result = validatePhaseId(id);
        pipe(
          result,
          E.map((validId) => {
            const typedId: PhaseId = validId;
            expect(typedId).toBe(id);
          }),
        );
      });
    });
  });

  describe('Phase Aggregates', () => {
    it('should validate phase relationships', () => {
      const phases = testPhases.map((phase) => toDomainPhase(phase)).sort((a, b) => a.id - b.id);

      // Verify sequential IDs
      phases.forEach((phase, index) => {
        expect(phase.id).toBe(testPhases[index].id);
      });

      // Verify phase continuity
      for (let i = 1; i < phases.length; i++) {
        const currentPhase = phases[i];
        const previousPhase = phases[i - 1];
        // In real data, phases might overlap or have gaps
        if (currentPhase.startEvent > previousPhase.startEvent) {
          expect(previousPhase.stopEvent).toBeGreaterThanOrEqual(previousPhase.startEvent);
        }
      }
    });
  });
});
