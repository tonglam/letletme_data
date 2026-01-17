import { beforeEach, describe, expect, test } from 'bun:test';

import type { PlayerTypeID, ValueChangeType } from '../../src/types/base.type';

import {
  determineValueChangeType,
  filterPlayerValuesByChangeType,
  filterPlayerValuesByPosition,
  filterPlayerValuesByTeam,
  getTopValueFallers,
  getTopValueRisers,
  getValueChangeAmount,
  getValueChangePercentage,
  getValueChangeStats,
  getValueInMillions,
  hasSignificantValueChange,
  isFallingInValue,
  isRisingInValue,
  sortPlayerValuesByChangeAmount,
  sortPlayerValuesByValue,
  validatePlayerValue,
  validatePlayerValues,
  validateRawPlayerValue,
} from '../../src/domain/player-values';
import { PlayerValuesRepository } from '../../src/repositories/player-values';
import {
  createPreviousValuesMap,
  createTeamsMap,
  extractPlayerIds,
  groupPlayerValuesByChangeType,
  groupPlayerValuesByPosition,
  groupPlayerValuesByTeam,
  safeTransformPlayerValue,
  transformPlayerValue,
  transformPlayerValues,
  transformPlayerValuesStrict,
  transformPlayerValuesWithChanges,
} from '../../src/transformers/player-values';
import {
  createMockPreviousValuesMap,
  generatePlayerValue,
  generatePlayerValues,
  generatePlayerValuesByPosition,
  generatePlayerValuesByTeam,
  generatePlayerValuesWithChanges,
  gkpPlayerValueFixture,
  invalidPlayerValueFixture,
  mockTeamsForPlayerValues,
  rawFPLElementsFixture,
  singlePlayerValueFixture,
  singleRawFPLElementFixture,
  singleRawPlayerValueFixture,
  transformedPlayerValuesFixture,
} from '../fixtures/player-values.fixtures';

describe('Player Values Unit Tests', () => {
  describe('Domain Logic Tests', () => {
    describe('Validation Functions', () => {
      test('should validate player value correctly', () => {
        expect(() => validatePlayerValue(singlePlayerValueFixture)).not.toThrow();
        const validatedValue = validatePlayerValue(singlePlayerValueFixture);
        expect(validatedValue).toEqual(singlePlayerValueFixture);
      });

      test('should validate raw player value correctly', () => {
        expect(() => validateRawPlayerValue(singleRawPlayerValueFixture)).not.toThrow();
        const validatedRawValue = validateRawPlayerValue(singleRawPlayerValueFixture);
        expect(validatedRawValue).toEqual(singleRawPlayerValueFixture);
      });

      test('should validate array of player values', () => {
        const playerValues = [singlePlayerValueFixture, gkpPlayerValueFixture];
        expect(() => validatePlayerValues(playerValues)).not.toThrow();
        const validatedValues = validatePlayerValues(playerValues);
        expect(validatedValues).toHaveLength(2);
        expect(validatedValues).toEqual(playerValues);
      });

      test('should throw on invalid player value', () => {
        expect(() => validatePlayerValue(invalidPlayerValueFixture)).toThrow();
      });

      test('should throw on invalid array element', () => {
        const invalidArray = [singlePlayerValueFixture, invalidPlayerValueFixture];
        expect(() => validatePlayerValues(invalidArray)).toThrow();
      });
    });

    describe('Business Logic Functions', () => {
      test('should calculate value change amount', () => {
        const risingPlayer = generatePlayerValue({ value: 90, lastValue: 80 });
        const fallingPlayer = generatePlayerValue({ value: 70, lastValue: 80 });
        const stablePlayer = generatePlayerValue({ value: 80, lastValue: 80 });

        expect(getValueChangeAmount(risingPlayer)).toBe(10);
        expect(getValueChangeAmount(fallingPlayer)).toBe(-10);
        expect(getValueChangeAmount(stablePlayer)).toBe(0);
      });

      test('should calculate value change percentage', () => {
        const risingPlayer = generatePlayerValue({ value: 90, lastValue: 80 });
        const fallingPlayer = generatePlayerValue({ value: 70, lastValue: 80 });

        expect(getValueChangePercentage(risingPlayer)).toBeCloseTo(12.5);
        expect(getValueChangePercentage(fallingPlayer)).toBeCloseTo(-12.5);

        // Edge case: lastValue is 0
        const zeroLastValue = generatePlayerValue({ value: 80, lastValue: 0 });
        expect(getValueChangePercentage(zeroLastValue)).toBe(0);
      });

      test('should determine value change type', () => {
        expect(determineValueChangeType(90, 80)).toBe('Rise');
        expect(determineValueChangeType(70, 80)).toBe('Faller');
        expect(determineValueChangeType(80, 80)).toBe('Start');
      });

      test('should check for significant value change', () => {
        const significantRise = generatePlayerValue({ value: 90, lastValue: 75 }); // 15 = 1.5m
        const minorRise = generatePlayerValue({ value: 85, lastValue: 80 }); // 5 = 0.5m

        expect(hasSignificantValueChange(significantRise)).toBe(true);
        expect(hasSignificantValueChange(minorRise)).toBe(false);
      });

      test('should convert value to millions', () => {
        expect(getValueInMillions(80)).toBe(8.0);
        expect(getValueInMillions(142)).toBe(14.2);
        expect(getValueInMillions(55)).toBe(5.5);
      });

      test('should check if player is rising/falling in value', () => {
        const risingPlayer = generatePlayerValue({ changeType: 'Rise' });
        const fallingPlayer = generatePlayerValue({ changeType: 'Faller' });
        const stablePlayer = generatePlayerValue({ changeType: 'Start' });

        expect(isRisingInValue(risingPlayer)).toBe(true);
        expect(isRisingInValue(fallingPlayer)).toBe(false);

        expect(isFallingInValue(fallingPlayer)).toBe(true);
        expect(isFallingInValue(risingPlayer)).toBe(false);
        expect(isFallingInValue(stablePlayer)).toBe(false);
      });
    });

    describe('Analytics Functions', () => {
      test('should get top value risers', () => {
        const playerValues = [
          generatePlayerValue({ elementId: 1, value: 100, lastValue: 80, changeType: 'Rise' }),
          generatePlayerValue({ elementId: 2, value: 90, lastValue: 85, changeType: 'Rise' }),
          generatePlayerValue({ elementId: 3, value: 70, lastValue: 80, changeType: 'Faller' }),
        ];

        const topRisers = getTopValueRisers(playerValues, 2);
        expect(topRisers).toHaveLength(2);
        expect(topRisers[0].elementId).toBe(1); // Highest increase (20)
        expect(topRisers[1].elementId).toBe(2); // Second highest (5)
      });

      test('should get top value fallers', () => {
        const playerValues = [
          generatePlayerValue({ elementId: 1, value: 60, lastValue: 80, changeType: 'Faller' }),
          generatePlayerValue({ elementId: 2, value: 75, lastValue: 85, changeType: 'Faller' }),
          generatePlayerValue({ elementId: 3, value: 100, lastValue: 80, changeType: 'Rise' }),
        ];

        const topFallers = getTopValueFallers(playerValues, 2);
        expect(topFallers).toHaveLength(2);
        expect(topFallers[0].elementId).toBe(1); // Highest decrease (20)
        expect(topFallers[1].elementId).toBe(2); // Second highest (10)
      });

      test('should calculate value change statistics', () => {
        const playerValues = generatePlayerValuesWithChanges();
        const stats = getValueChangeStats(playerValues);

        expect(stats.totalRisers).toBe(1);
        expect(stats.totalFallers).toBe(1);
        expect(stats.totalStable).toBe(1);
        expect(stats.averageValue).toBe(80); // (90 + 70 + 80) / 3
        expect(stats.totalValueChange).toBe(0); // 10 - 10 + 0
      });
    });

    describe('Filtering and Sorting Functions', () => {
      test('should filter player values by position', () => {
        const playerValues = generatePlayerValuesByPosition();

        const goalkeepers = filterPlayerValuesByPosition(playerValues, 1 as PlayerTypeID);
        const defenders = filterPlayerValuesByPosition(playerValues, 2 as PlayerTypeID);
        const midfielders = filterPlayerValuesByPosition(playerValues, 3 as PlayerTypeID);
        const forwards = filterPlayerValuesByPosition(playerValues, 4 as PlayerTypeID);

        expect(goalkeepers).toHaveLength(1);
        expect(defenders).toHaveLength(1);
        expect(midfielders).toHaveLength(1);
        expect(forwards).toHaveLength(1);

        expect(goalkeepers[0].elementTypeName).toBe('GKP');
        expect(defenders[0].elementTypeName).toBe('DEF');
        expect(midfielders[0].elementTypeName).toBe('MID');
        expect(forwards[0].elementTypeName).toBe('FWD');
      });

      test('should filter player values by team', () => {
        const playerValues = generatePlayerValuesByTeam();

        const teamAPlayers = filterPlayerValuesByTeam(playerValues, 1);
        const teamBPlayers = filterPlayerValuesByTeam(playerValues, 2);

        expect(teamAPlayers).toHaveLength(2);
        expect(teamBPlayers).toHaveLength(1);
        expect(teamAPlayers.every((p) => p.teamId === 1)).toBe(true);
        expect(teamBPlayers.every((p) => p.teamId === 2)).toBe(true);
      });

      test('should filter player values by change type', () => {
        const playerValues = generatePlayerValuesWithChanges();

        const risers = filterPlayerValuesByChangeType(playerValues, 'Rise' as ValueChangeType);
        const fallers = filterPlayerValuesByChangeType(playerValues, 'Faller' as ValueChangeType);
        const stable = filterPlayerValuesByChangeType(playerValues, 'Start' as ValueChangeType);

        expect(risers).toHaveLength(1);
        expect(fallers).toHaveLength(1);
        expect(stable).toHaveLength(1);

        expect(risers[0].changeType).toBe('Rise');
        expect(fallers[0].changeType).toBe('Faller');
        expect(stable[0].changeType).toBe('Start');
      });

      test('should sort player values by value', () => {
        const playerValues = [
          generatePlayerValue({ elementId: 1, value: 100 }),
          generatePlayerValue({ elementId: 2, value: 60 }),
          generatePlayerValue({ elementId: 3, value: 80 }),
        ];

        const sorted = sortPlayerValuesByValue(playerValues);
        expect(sorted.map((p) => p.value)).toEqual([60, 80, 100]);
        expect(sorted.map((p) => p.elementId)).toEqual([2, 3, 1]);
      });

      test('should sort player values by change amount', () => {
        const playerValues = [
          generatePlayerValue({ elementId: 1, value: 90, lastValue: 80 }), // +10
          generatePlayerValue({ elementId: 2, value: 75, lastValue: 85 }), // -10
          generatePlayerValue({ elementId: 3, value: 105, lastValue: 80 }), // +25
        ];

        const sorted = sortPlayerValuesByChangeAmount(playerValues);
        const changeAmounts = sorted.map((p) => getValueChangeAmount(p));
        expect(changeAmounts).toEqual([25, 10, -10]); // Descending order
        expect(sorted.map((p) => p.elementId)).toEqual([3, 1, 2]);
      });
    });
  });

  describe('Repository Tests', () => {
    let repository: PlayerValuesRepository;

    beforeEach(() => {
      repository = new PlayerValuesRepository();
    });

    test('should create repository instance', () => {
      expect(repository).toBeInstanceOf(PlayerValuesRepository);
    });
  });

  describe('Transformer Tests', () => {
    const teamsMap = createTeamsMap(mockTeamsForPlayerValues);
    const previousValuesMap = createMockPreviousValuesMap();

    describe('Single Transformation', () => {
      test('should transform single raw FPL element to player value', () => {
        const transformed = transformPlayerValue(
          singleRawFPLElementFixture,
          15,
          teamsMap,
          previousValuesMap,
          '2023-12-15T10:00:00.000Z',
        );

        expect(transformed.elementId).toBe(1);
        expect(transformed.webName).toBe('Haaland');
        expect(transformed.elementType).toBe(4);
        expect(transformed.elementTypeName).toBe('FWD');
        expect(transformed.teamId).toBe(11);
        expect(transformed.teamName).toBe('Manchester City');
        expect(transformed.teamShortName).toBe('MCI');
        expect(transformed.value).toBe(142);
        expect(transformed.lastValue).toBe(138);
        expect(transformed.changeType).toBe('Rise');
        expect(transformed.changeDate).toBe('2023-12-15T10:00:00.000Z');
      });

      test('should handle transformation without previous values', () => {
        const transformed = transformPlayerValue(singleRawFPLElementFixture, 15, teamsMap);

        expect(transformed.value).toBe(142);
        expect(transformed.lastValue).toBe(142); // Same as current when no previous
        expect(transformed.changeType).toBe('Start');
      });

      test('should throw on invalid team ID', () => {
        const invalidElement = {
          ...singleRawFPLElementFixture,
          team: 999, // Team not in map
        };

        expect(() => transformPlayerValue(invalidElement, 15, teamsMap)).toThrow(
          'Team not found for ID: 999',
        );
      });

      test('should return null for safe transformation on error', () => {
        const invalidElement = {
          ...singleRawFPLElementFixture,
          team: 999,
        };

        const result = safeTransformPlayerValue(invalidElement, 15, teamsMap);
        expect(result).toBeNull();
      });
    });

    describe('Bulk Transformation', () => {
      test('should transform array of raw FPL elements', () => {
        const transformed = transformPlayerValues(
          rawFPLElementsFixture,
          15,
          teamsMap,
          previousValuesMap,
        );

        expect(transformed).toHaveLength(3);
        expect(transformed[0].webName).toBe('Haaland');
        expect(transformed[1].webName).toBe('Alisson');
        expect(transformed[2].webName).toBe('Alexander-Arnold');
      });

      test('should handle partial transformation errors gracefully', () => {
        const mixedElements = [
          singleRawFPLElementFixture,
          { ...singleRawFPLElementFixture, team: 999 }, // Invalid
          rawFPLElementsFixture[1], // Valid
        ];

        const transformed = transformPlayerValues(mixedElements, 15, teamsMap);
        expect(transformed).toHaveLength(2); // Only valid ones
      });

      test('should throw on strict transformation with any error', () => {
        const mixedElements = [
          singleRawFPLElementFixture,
          { ...singleRawFPLElementFixture, team: 999 },
        ];

        expect(() => transformPlayerValuesStrict(mixedElements, 15, teamsMap)).toThrow();
      });
    });

    describe('Daily change transformation', () => {
      const changeDate = '20250101';

      test('should label first-time records as Start', () => {
        const player = { ...singleRawFPLElementFixture, id: 501, now_cost: 60 };
        const transformed = transformPlayerValuesWithChanges(
          [player],
          20,
          teamsMap,
          new Map(),
          changeDate,
        );

        expect(transformed).toHaveLength(1);
        expect(transformed[0].changeType).toBe('Start');
        expect(transformed[0].lastValue).toBe(0);
      });

      test('should label increases as Rise after initial record', () => {
        const player = { ...singleRawFPLElementFixture, id: 777, now_cost: 60 };
        const lastValueMap = new Map<number, number>([[player.id, 55]]);

        const transformed = transformPlayerValuesWithChanges(
          [player],
          21,
          teamsMap,
          lastValueMap,
          changeDate,
        );

        expect(transformed[0].changeType).toBe('Rise');
        expect(transformed[0].lastValue).toBe(55);
      });

      test('should label decreases as Faller after initial record', () => {
        const player = { ...singleRawFPLElementFixture, id: 888, now_cost: 60 };
        const lastValueMap = new Map<number, number>([[player.id, 65]]);

        const transformed = transformPlayerValuesWithChanges(
          [player],
          22,
          teamsMap,
          lastValueMap,
          changeDate,
        );

        expect(transformed[0].changeType).toBe('Faller');
        expect(transformed[0].lastValue).toBe(65);
      });
    });

    describe('Helper Functions', () => {
      test('should create teams map from team data', () => {
        const teams = mockTeamsForPlayerValues;
        const map = createTeamsMap(teams);

        expect(map.size).toBe(4);
        expect(map.get(11)).toEqual({ name: 'Manchester City', shortName: 'MCI' });
        expect(map.get(14)).toEqual({ name: 'Liverpool', shortName: 'LIV' });
      });

      test('should create previous values map', () => {
        const previousValues = [
          { elementId: 1, value: 138 },
          { elementId: 20, value: 55 },
        ];

        const map = createPreviousValuesMap(previousValues);
        expect(map.size).toBe(2);
        expect(map.get(1)).toBe(138);
        expect(map.get(20)).toBe(55);
      });

      test('should extract unique player IDs', () => {
        const playerValues = [
          generatePlayerValue({ elementId: 1 }),
          generatePlayerValue({ elementId: 2 }),
          generatePlayerValue({ elementId: 1 }), // Duplicate
        ];

        const playerIds = extractPlayerIds(playerValues);
        expect(playerIds).toHaveLength(2);
        expect(playerIds).toContain(1);
        expect(playerIds).toContain(2);
      });

      test('should group player values by position', () => {
        const playerValues = transformedPlayerValuesFixture;
        const grouped = groupPlayerValuesByPosition(playerValues);

        expect(grouped.GKP).toHaveLength(1);
        expect(grouped.DEF).toHaveLength(1);
        expect(grouped.MID).toHaveLength(1);
        expect(grouped.FWD).toHaveLength(1);

        expect(grouped.GKP[0].webName).toBe('Alisson');
        expect(grouped.FWD[0].webName).toBe('Salah');
      });

      test('should group player values by team', () => {
        const playerValues = transformedPlayerValuesFixture;
        const grouped = groupPlayerValuesByTeam(playerValues);

        expect(grouped[11]).toHaveLength(1); // Manchester City
        expect(grouped[14]).toHaveLength(3); // Liverpool

        expect(grouped[11][0].webName).toBe('De Bruyne');
        expect(grouped[14].map((p) => p.webName)).toContain('Alisson');
        expect(grouped[14].map((p) => p.webName)).toContain('Alexander-Arnold');
        expect(grouped[14].map((p) => p.webName)).toContain('Salah');
      });

      test('should group player values by change type', () => {
        const playerValues = generatePlayerValuesWithChanges();
        const grouped = groupPlayerValuesByChangeType(playerValues);

        expect(grouped.Rise).toHaveLength(1);
        expect(grouped.Faller).toHaveLength(1);
        expect(grouped.Start).toHaveLength(1);

        expect(grouped.Rise[0].webName).toBe('Rising Player');
        expect(grouped.Faller[0].webName).toBe('Falling Player');
      });
    });
  });

  describe('Edge Cases and Error Handling', () => {
    test('should handle empty arrays gracefully', () => {
      expect(getTopValueRisers([])).toHaveLength(0);
      expect(getTopValueFallers([])).toHaveLength(0);

      const stats = getValueChangeStats([]);
      expect(stats.totalRisers).toBe(0);
      expect(stats.averageValue).toBe(0);
    });

    test('should handle filtering with no matches', () => {
      const playerValues = [generatePlayerValue({ elementType: 1 })];

      const midfielders = filterPlayerValuesByPosition(playerValues, 3 as PlayerTypeID);
      expect(midfielders).toHaveLength(0);

      const teamBPlayers = filterPlayerValuesByTeam(playerValues, 99);
      expect(teamBPlayers).toHaveLength(0);
    });

    test('should handle negative limits gracefully', () => {
      const playerValues = generatePlayerValues(5);

      const risers = getTopValueRisers(playerValues, -1);
      expect(risers).toHaveLength(0);
    });

    test('should handle very large limits', () => {
      const playerValues = generatePlayerValues(3);

      const risers = getTopValueRisers(playerValues, 100);
      expect(risers.length).toBeLessThanOrEqual(3);
    });
  });
});
