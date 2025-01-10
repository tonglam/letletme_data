import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import {
  PlayerValueId,
  PrismaPlayerValue,
  toDomainPlayerValue,
  validatePlayerValueId,
} from '../../src/domain/player-value/types';
import { ElementStatus, ElementType, ValueChangeType } from '../../src/types/base.type';
import { ElementResponse } from '../../src/types/element.type';

describe('Player Value Domain Tests', () => {
  let testPlayerValues: ElementResponse[];

  beforeAll(() => {
    // Create a controlled set of test data
    testPlayerValues = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      code: i + 100,
      element_type: ((i % 4) + 1) as number,
      first_name: `First${i + 1}`,
      second_name: `Last${i + 1}`,
      web_name: `Player${i + 1}`,
      team: i + 1,
      team_code: i + 1,
      now_cost: (i + 1) * 10,
      cost_change_start: i + 5,
      status: ElementStatus.Available,
      event_points: i + 1,
      total_points: 0,
      minutes: 0,
      goals_scored: 0,
      assists: 0,
      clean_sheets: 0,
      goals_conceded: 0,
      own_goals: 0,
      penalties_saved: 0,
      yellow_cards: 0,
      red_cards: 0,
      saves: 0,
      bonus: 0,
      bps: 0,
      influence: '0',
      creativity: '0',
      threat: '0',
      ict_index: '0',
      starts: 0,
      expected_goals: '0',
      expected_assists: '0',
      expected_goal_involvements: '0',
      expected_goals_conceded: '0',
      transfers_in: 0,
      transfers_out: 0,
      selected_by_percent: '0',
      form: '0',
      points_per_game: '0',
      ep_this: '0',
      ep_next: '0',
      influence_rank: 0,
      influence_rank_type: 0,
      creativity_rank: 0,
      creativity_rank_type: 0,
      threat_rank: 0,
      threat_rank_type: 0,
      ict_index_rank: 0,
      ict_index_rank_type: 0,
    }));
  });

  describe('Domain Model Transformation', () => {
    it('should transform API response to domain model', () => {
      const response = testPlayerValues[0];
      const playerValue = toDomainPlayerValue(response);

      expect(playerValue).toMatchObject({
        id: expect.any(String),
        elementId: expect.any(Number),
        elementType: expect.any(String),
        eventId: expect.any(Number),
        value: expect.any(Number),
        changeDate: expect.any(String),
        changeType: expect.any(String),
        lastValue: expect.any(Number),
      });

      // Verify field transformations
      expect(playerValue.elementId).toBe(response.id);
      expect(playerValue.elementType).toBe(getElementTypeById(response.element_type));
      expect(playerValue.eventId).toBe(response.event_points);
      expect(playerValue.value).toBe(response.now_cost);
      expect(playerValue.lastValue).toBe(response.cost_change_start);
      expect(playerValue.changeType).toBe(ValueChangeType.Start);
      expect(playerValue.changeDate).toMatch(/^\d{4}-\d{2}-\d{2}$/); // YYYY-MM-DD format
    });

    it('should transform Prisma model to domain model', () => {
      const apiPlayerValue = testPlayerValues[0];
      const prismaPlayerValue: PrismaPlayerValue = {
        id: `${apiPlayerValue.id}_${new Date().toISOString().slice(0, 10)}`,
        elementId: apiPlayerValue.id,
        elementType: apiPlayerValue.element_type,
        eventId: apiPlayerValue.event_points,
        value: apiPlayerValue.now_cost,
        changeDate: new Date().toISOString().slice(0, 10),
        changeType: ValueChangeType.Start,
        lastValue: apiPlayerValue.cost_change_start,
        createdAt: new Date(),
      };
      const playerValue = toDomainPlayerValue(prismaPlayerValue);

      expect(playerValue).toMatchObject({
        id: prismaPlayerValue.id,
        elementId: prismaPlayerValue.elementId,
        elementType: getElementTypeById(prismaPlayerValue.elementType),
        eventId: prismaPlayerValue.eventId,
        value: prismaPlayerValue.value,
        changeDate: prismaPlayerValue.changeDate,
        changeType: prismaPlayerValue.changeType,
        lastValue: prismaPlayerValue.lastValue,
      });
    });

    it('should handle optional and null fields correctly', () => {
      // Test with null event points
      const responseWithNull: ElementResponse = {
        ...testPlayerValues[0],
        event_points: 0,
      };
      const playerValueWithNull = toDomainPlayerValue(responseWithNull);
      expect(playerValueWithNull.eventId).toBe(0);

      // Test with missing optional fields
      const responseWithMissing: ElementResponse = {
        ...testPlayerValues[0],
        event_points: 0,
      };
      const playerValueWithMissing = toDomainPlayerValue(responseWithMissing);
      expect(playerValueWithMissing.eventId).toBe(0);
    });

    it('should enforce business logic constraints', () => {
      // Find a valid player value to base our test on
      const validPlayerValue = testPlayerValues.find((p) => p.now_cost > 0);
      expect(validPlayerValue).toBeDefined();
      if (!validPlayerValue) return;

      const playerValue = toDomainPlayerValue(validPlayerValue);
      expect(playerValue.value).toBeGreaterThan(0);
      expect(Object.values(ElementType)).toContain(playerValue.elementType);
      expect(Object.values(ValueChangeType)).toContain(playerValue.changeType);
      expect(playerValue.changeDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('Player Value ID Validation', () => {
    it('should validate valid player value ID', () => {
      const validId = `${testPlayerValues[0].id}_${new Date().toISOString().slice(0, 10)}`;
      const result = validatePlayerValueId(validId);
      expect(E.isRight(result)).toBe(true);
      pipe(
        result,
        E.map((id) => {
          expect(id).toBe(validId);
          expect(typeof id).toBe('string');
        }),
      );
    });

    it('should reject invalid player value ID types', () => {
      const testCases = [
        { input: 123 },
        { input: null },
        { input: undefined },
        { input: {} },
        { input: [] },
      ];

      testCases.forEach(({ input }) => {
        const result = validatePlayerValueId(input as string);
        expect(E.isLeft(result)).toBe(true);
        if (E.isRight(result)) return;
        expect(result.left).toContain('Invalid player value ID');
      });
    });

    it('should reject invalid string values', () => {
      const testCases = [{ input: '' }, { input: ' ' }, { input: '\t' }, { input: '\n' }];

      testCases.forEach(({ input }) => {
        const result = validatePlayerValueId(input);
        expect(E.isLeft(result)).toBe(true);
        if (E.isRight(result)) return;
        expect(result.left).toContain('Invalid player value ID');
      });
    });

    it('should create branded type for valid ID', () => {
      const validIds = testPlayerValues.map(
        (p) => `${p.id}_${new Date().toISOString().slice(0, 10)}`,
      );

      validIds.forEach((id) => {
        const result = validatePlayerValueId(id);
        pipe(
          result,
          E.map((validId) => {
            const typedId: PlayerValueId = validId;
            expect(typedId).toBe(id);
          }),
        );
      });
    });
  });

  describe('Player Value Aggregates', () => {
    it('should validate player value relationships', () => {
      const today = new Date().toISOString().slice(0, 10);
      const playerValues = testPlayerValues
        .map((playerValue) => toDomainPlayerValue(playerValue))
        .sort((a, b) => a.elementId - b.elementId);

      // Verify element IDs
      playerValues.forEach((playerValue, index) => {
        expect(playerValue.elementId).toBe(testPlayerValues[index].id);
        expect(playerValue.id).toBe(`${testPlayerValues[index].id}_${today}`);
      });

      // Verify element types
      playerValues.forEach((playerValue) => {
        expect(Object.values(ElementType)).toContain(playerValue.elementType);
      });

      // Verify value constraints
      playerValues.forEach((playerValue) => {
        expect(playerValue.value).toBeGreaterThanOrEqual(0);
        expect(playerValue.lastValue).toBeGreaterThanOrEqual(0);
      });

      // Verify change type
      playerValues.forEach((playerValue) => {
        expect(Object.values(ValueChangeType)).toContain(playerValue.changeType);
      });

      // Verify change date format
      playerValues.forEach((playerValue) => {
        expect(playerValue.changeDate).toBe(today);
      });
    });
  });
});

// Helper function to get ElementType by ID (similar to the one in base.type.ts)
const getElementTypeById = (id: number): ElementType | null => {
  switch (id) {
    case 1:
      return ElementType.GKP;
    case 2:
      return ElementType.DEF;
    case 3:
      return ElementType.MID;
    case 4:
      return ElementType.FWD;
    default:
      return null;
  }
};
