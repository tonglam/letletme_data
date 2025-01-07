import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import {
  Phase,
  PhaseId,
  PhaseResponse,
  PrismaPhase,
  toDomainPhase,
  validatePhaseId,
} from '../../src/domain/phase/types';
import { getTestPhase } from '../data/bootstrap.test';

describe('Phase Domain', () => {
  describe('toDomainPhase', () => {
    it('should convert API response to domain model', () => {
      const response = getTestPhase(1) as PhaseResponse;
      const phase: Phase = toDomainPhase(response);

      expect(phase.id).toBeDefined();
      expect(phase.name).toBe(response.name);
      expect(phase.startEvent).toBe(response.start_event);
      expect(phase.stopEvent).toBe(response.stop_event);
      expect(phase.highestScore).toBe(response.highest_score);
    });

    it('should convert Prisma model to domain model', () => {
      const response = getTestPhase(1) as PhaseResponse;
      const prismaPhase: PrismaPhase = {
        id: response.id,
        name: response.name,
        startEvent: response.start_event,
        stopEvent: response.stop_event,
        highestScore: response.highest_score,
        createdAt: new Date(),
      };
      const phase: Phase = toDomainPhase(prismaPhase);

      expect(phase.id).toBeDefined();
      expect(phase.name).toBe(prismaPhase.name);
      expect(phase.startEvent).toBe(prismaPhase.startEvent);
      expect(phase.stopEvent).toBe(prismaPhase.stopEvent);
      expect(phase.highestScore).toBe(prismaPhase.highestScore);
    });

    it('should handle null values in API response', () => {
      const response: PhaseResponse = {
        ...getTestPhase(1)!,
        highest_score: null,
      };
      const phase: Phase = toDomainPhase(response);

      expect(phase.highestScore).toBeNull();
    });

    it('should handle null values in Prisma model', () => {
      const response = getTestPhase(1) as PhaseResponse;
      const prismaPhase: PrismaPhase = {
        id: response.id,
        name: response.name,
        startEvent: response.start_event,
        stopEvent: response.stop_event,
        highestScore: null,
        createdAt: new Date(),
      };
      const phase: Phase = toDomainPhase(prismaPhase);

      expect(phase.highestScore).toBeNull();
    });
  });

  describe('validatePhaseId', () => {
    it('should validate valid phase ID', () => {
      const result = validatePhaseId(1);
      expect(E.isRight(result)).toBe(true);
      pipe(
        result,
        E.map((id) => {
          expect(id).toBe(1);
          expect(typeof id).toBe('number');
        }),
      );
    });

    it('should reject invalid phase ID types', () => {
      const stringResult = validatePhaseId('invalid');
      expect(E.isLeft(stringResult)).toBe(true);

      const nullResult = validatePhaseId(null);
      expect(E.isLeft(nullResult)).toBe(true);

      const undefinedResult = validatePhaseId(undefined);
      expect(E.isLeft(undefinedResult)).toBe(true);
    });

    it('should reject non-positive numbers', () => {
      const zeroResult = validatePhaseId(0);
      expect(E.isLeft(zeroResult)).toBe(true);

      const negativeResult = validatePhaseId(-1);
      expect(E.isLeft(negativeResult)).toBe(true);
    });

    it('should reject non-integer numbers', () => {
      const floatResult = validatePhaseId(1.5);
      expect(E.isLeft(floatResult)).toBe(true);
    });

    it('should create branded type for valid ID', () => {
      const result = validatePhaseId(1);
      pipe(
        result,
        E.map((id) => {
          const typedId: PhaseId = id;
          expect(typedId).toBe(1);
        }),
      );
    });
  });
});
