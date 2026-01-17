import { beforeEach, describe, expect, test } from 'bun:test';

import {
  cameOffBench,
  getPerformanceSummary,
  hasBonusPoints,
  hasCard,
  hasGoalInvolvement,
  hasPlayed,
  hasStarted,
  isInDreamTeam,
  safeValidateEventLive,
  validateEventLive,
  validateEventLives,
  wasSentOff,
} from '../../src/domain/event-lives';
import {
  createEventLiveRepository,
  type EventLiveRepository,
} from '../../src/repositories/event-lives';
import { transformEventLive, transformEventLives } from '../../src/transformers/event-lives';
import {
  benchPlayerEventLiveFixture,
  goalkeepperEventLiveFixture,
  rawFPLEventLiveElementsFixture,
  redCardEventLiveFixture,
  singleRawEventLiveElementFixture,
  singleTransformedEventLiveFixture,
  transformedEventLivesFixture,
} from '../fixtures/event-lives.fixtures';

describe('Event Lives Unit Tests', () => {
  describe('transformEventLives Function', () => {
    const eventId = 15;

    test('should transform single event live correctly', () => {
      const result = transformEventLive(eventId, singleRawEventLiveElementFixture);

      expect(result).toEqual(singleTransformedEventLiveFixture);
      expect(result.eventId).toBe(15);
      expect(result.elementId).toBe(350);
      expect(result.minutes).toBe(90);
      expect(result.goalsScored).toBe(2);
      expect(result.assists).toBe(1);
      expect(result.totalPoints).toBe(15);
      expect(result.inDreamTeam).toBe(true);
    });

    test('should transform multiple event lives correctly', () => {
      const result = transformEventLives(eventId, rawFPLEventLiveElementsFixture);

      expect(result).toHaveLength(3);
      expect(result).toEqual(transformedEventLivesFixture);

      // Verify transformation accuracy
      result.forEach((eventLive, index) => {
        const rawElement = rawFPLEventLiveElementsFixture[index];
        expect(eventLive.eventId).toBe(eventId);
        expect(eventLive.elementId).toBe(rawElement.id);
        expect(eventLive.minutes).toBe(rawElement.stats.minutes);
        expect(eventLive.goalsScored).toBe(rawElement.stats.goals_scored);
        expect(eventLive.assists).toBe(rawElement.stats.assists);
        expect(eventLive.totalPoints).toBe(rawElement.stats.total_points);
        expect(eventLive.inDreamTeam).toBe(rawElement.stats.in_dreamteam);
      });
    });

    test('should handle empty array', () => {
      const result = transformEventLives(eventId, []);
      expect(result).toEqual([]);
      expect(result).toHaveLength(0);
    });

    test('should correctly convert starts field', () => {
      const starterElement = {
        ...singleRawEventLiveElementFixture,
        stats: { ...singleRawEventLiveElementFixture.stats, starts: 1 },
      };
      const benchElement = {
        ...singleRawEventLiveElementFixture,
        stats: { ...singleRawEventLiveElementFixture.stats, starts: 0 },
      };

      const starter = transformEventLive(eventId, starterElement);
      const bench = transformEventLive(eventId, benchElement);

      expect(starter.starts).toBe(true);
      expect(bench.starts).toBe(false);
    });

    test('should handle zero values correctly', () => {
      const elementWithZeros = {
        id: 999,
        stats: {
          minutes: 0,
          goals_scored: 0,
          assists: 0,
          clean_sheets: 0,
          goals_conceded: 0,
          own_goals: 0,
          penalties_saved: 0,
          penalties_missed: 0,
          yellow_cards: 0,
          red_cards: 0,
          saves: 0,
          bonus: 0,
          bps: 0,
          influence: '0.0',
          creativity: '0.0',
          threat: '0.0',
          ict_index: '0.0',
          starts: 0,
          expected_goals: '0.00',
          expected_assists: '0.00',
          expected_goal_involvements: '0.00',
          expected_goals_conceded: '0.00',
          total_points: 0,
          in_dreamteam: false,
        },
        explain: [],
      };

      const result = transformEventLive(eventId, elementWithZeros);
      expect(result.minutes).toBe(0);
      expect(result.totalPoints).toBe(0);
      expect(result.starts).toBe(false);
    });

    test('should handle large datasets efficiently', () => {
      const largeDataset = Array(1000)
        .fill(singleRawEventLiveElementFixture)
        .map((element, index) => ({
          ...element,
          id: index + 1,
        }));

      const startTime = performance.now();
      const result = transformEventLives(eventId, largeDataset);
      const endTime = performance.now();

      expect(result).toHaveLength(1000);
      expect(endTime - startTime).toBeLessThan(100); // Should complete in under 100ms
    });
  });

  describe('Domain Validation Functions', () => {
    test('should validate correct event live data', () => {
      expect(() => validateEventLive(singleTransformedEventLiveFixture)).not.toThrow();
      const result = validateEventLive(singleTransformedEventLiveFixture);
      expect(result).toEqual(singleTransformedEventLiveFixture);
    });

    test('should validate array of event lives', () => {
      expect(() => validateEventLives(transformedEventLivesFixture)).not.toThrow();
      const result = validateEventLives(transformedEventLivesFixture);
      expect(result).toEqual(transformedEventLivesFixture);
    });

    test('should throw on invalid event live data', () => {
      const invalidData = {
        eventId: 'invalid', // Should be number
        elementId: 350,
      };

      expect(() => validateEventLive(invalidData)).toThrow();
    });

    test('should safely validate and return null on failure', () => {
      const invalidData = { eventId: 'invalid' };
      const result = safeValidateEventLive(invalidData);
      expect(result).toBeNull();
    });

    test('should safely validate correct data', () => {
      const result = safeValidateEventLive(singleTransformedEventLiveFixture);
      expect(result).toEqual(singleTransformedEventLiveFixture);
    });
  });

  describe('Domain Business Logic - Player Status', () => {
    test('hasPlayed should correctly identify played status', () => {
      expect(hasPlayed(singleTransformedEventLiveFixture)).toBe(true);
      expect(hasPlayed(benchPlayerEventLiveFixture)).toBe(false);
      expect(hasPlayed({ ...singleTransformedEventLiveFixture, minutes: 0 })).toBe(false);
      expect(hasPlayed({ ...singleTransformedEventLiveFixture, minutes: null })).toBe(false);
    });

    test('hasStarted should correctly identify starting status', () => {
      expect(hasStarted(singleTransformedEventLiveFixture)).toBe(true);
      expect(hasStarted(benchPlayerEventLiveFixture)).toBe(false);
      expect(hasStarted({ ...singleTransformedEventLiveFixture, starts: false })).toBe(false);
      expect(hasStarted({ ...singleTransformedEventLiveFixture, starts: null })).toBe(false);
    });

    test('cameOffBench should correctly identify substitute status', () => {
      const substitute = { ...singleTransformedEventLiveFixture, starts: false, minutes: 25 };
      expect(cameOffBench(substitute)).toBe(true);
      expect(cameOffBench(singleTransformedEventLiveFixture)).toBe(false); // Started
      expect(cameOffBench(benchPlayerEventLiveFixture)).toBe(false); // Did not play
    });

    test('hasCard should correctly identify card status', () => {
      const yellowCard = { ...singleTransformedEventLiveFixture, yellowCards: 1 };
      const noCard = { ...singleTransformedEventLiveFixture, yellowCards: 0, redCards: 0 };

      expect(hasCard(yellowCard)).toBe(true);
      expect(hasCard(redCardEventLiveFixture)).toBe(true);
      expect(hasCard(noCard)).toBe(false);
    });

    test('wasSentOff should correctly identify red card status', () => {
      expect(wasSentOff(redCardEventLiveFixture)).toBe(true);
      expect(wasSentOff(singleTransformedEventLiveFixture)).toBe(false);
    });

    test('hasGoalInvolvement should correctly identify goal involvement', () => {
      expect(hasGoalInvolvement(singleTransformedEventLiveFixture)).toBe(true); // Has goals and assists
      const noInvolvement = {
        ...singleTransformedEventLiveFixture,
        goalsScored: 0,
        assists: 0,
      };
      expect(hasGoalInvolvement(noInvolvement)).toBe(false);
    });

    test('hasBonusPoints should correctly identify bonus status', () => {
      expect(hasBonusPoints(singleTransformedEventLiveFixture)).toBe(true);
      expect(hasBonusPoints(benchPlayerEventLiveFixture)).toBe(false);
    });

    test('isInDreamTeam should correctly identify dream team status', () => {
      expect(isInDreamTeam(singleTransformedEventLiveFixture)).toBe(true);
      expect(isInDreamTeam(benchPlayerEventLiveFixture)).toBe(false);
    });
  });

  describe('Domain Business Logic - Performance Summary', () => {
    test('should generate correct performance summary for striker', () => {
      const summary = getPerformanceSummary(singleTransformedEventLiveFixture);

      expect(summary).toEqual({
        played: true,
        started: true,
        points: 15,
        goals: 2,
        assists: 1,
        cleanSheet: false,
        cards: { yellow: 0, red: 0 },
        bonus: 3,
      });
    });

    test('should generate correct performance summary for goalkeeper', () => {
      const summary = getPerformanceSummary(goalkeepperEventLiveFixture);

      expect(summary).toEqual({
        played: true,
        started: true,
        points: 10,
        goals: 0,
        assists: 0,
        cleanSheet: true,
        cards: { yellow: 0, red: 0 },
        bonus: 3,
      });
    });

    test('should generate correct performance summary for sent off player', () => {
      const summary = getPerformanceSummary(redCardEventLiveFixture);

      expect(summary).toEqual({
        played: true,
        started: true,
        points: -2,
        goals: 0,
        assists: 0,
        cleanSheet: false,
        cards: { yellow: 0, red: 1 },
        bonus: 0,
      });
    });

    test('should generate correct performance summary for bench player', () => {
      const summary = getPerformanceSummary(benchPlayerEventLiveFixture);

      expect(summary).toEqual({
        played: false,
        started: false,
        points: 0,
        goals: 0,
        assists: 0,
        cleanSheet: false,
        cards: { yellow: 0, red: 0 },
        bonus: 0,
      });
    });
  });

  describe('EventLiveRepository Unit Tests', () => {
    let repository: EventLiveRepository;

    beforeEach(() => {
      repository = createEventLiveRepository();
    });

    test('should create repository instance', () => {
      expect(repository).toBeDefined();
      expect(repository.findByEventId).toBeDefined();
      expect(repository.upsertBatch).toBeDefined();
    });

    test('should handle repository method signatures', () => {
      expect(typeof repository.findByEventId).toBe('function');
      expect(typeof repository.upsertBatch).toBe('function');
    });

    test('should handle upsertBatch with empty array', async () => {
      const result = await repository.upsertBatch([]);
      expect(result).toBeDefined();
    });
  });

  describe('Transformation Output Validation', () => {
    test('should validate transformation output format', () => {
      const result = transformEventLives(15, rawFPLEventLiveElementsFixture);

      result.forEach((eventLive) => {
        // Required fields should be present and correct type
        expect(typeof eventLive.eventId).toBe('number');
        expect(typeof eventLive.elementId).toBe('number');
        expect(typeof eventLive.totalPoints).toBe('number');

        // Nullable numeric fields
        expect(['number', 'object']).toContain(typeof eventLive.minutes);
        expect(['number', 'object']).toContain(typeof eventLive.goalsScored);
        expect(['number', 'object']).toContain(typeof eventLive.assists);

        // Boolean fields
        expect(['boolean', 'object']).toContain(typeof eventLive.starts);
        expect(['boolean', 'object']).toContain(typeof eventLive.inDreamTeam);

        // String fields (expected values)
        expect(['string', 'object']).toContain(typeof eventLive.expectedGoals);
        expect(['string', 'object']).toContain(typeof eventLive.expectedAssists);

        // Should have all camelCase properties
        expect(eventLive).toHaveProperty('eventId');
        expect(eventLive).toHaveProperty('elementId');
        expect(eventLive).toHaveProperty('goalsScored');
        expect(eventLive).toHaveProperty('cleanSheets');
        expect(eventLive).toHaveProperty('goalsConceded');
        expect(eventLive).toHaveProperty('ownGoals');
        expect(eventLive).toHaveProperty('penaltiesSaved');
        expect(eventLive).toHaveProperty('penaltiesMissed');
        expect(eventLive).toHaveProperty('yellowCards');
        expect(eventLive).toHaveProperty('redCards');
        expect(eventLive).toHaveProperty('totalPoints');
        expect(eventLive).toHaveProperty('inDreamTeam');

        // Should not have snake_case properties
        expect(eventLive).not.toHaveProperty('event_id');
        expect(eventLive).not.toHaveProperty('element_id');
        expect(eventLive).not.toHaveProperty('goals_scored');
        expect(eventLive).not.toHaveProperty('clean_sheets');
        expect(eventLive).not.toHaveProperty('goals_conceded');
        expect(eventLive).not.toHaveProperty('own_goals');
        expect(eventLive).not.toHaveProperty('penalties_saved');
        expect(eventLive).not.toHaveProperty('penalties_missed');
        expect(eventLive).not.toHaveProperty('yellow_cards');
        expect(eventLive).not.toHaveProperty('red_cards');
        expect(eventLive).not.toHaveProperty('total_points');
        expect(eventLive).not.toHaveProperty('in_dreamteam');
      });
    });
  });

  describe('Data Consistency Tests', () => {
    test('should maintain data consistency across transformations', () => {
      const eventId = 15;
      const input = rawFPLEventLiveElementsFixture;
      const output = transformEventLives(eventId, input);

      expect(output.length).toBe(input.length);

      input.forEach((rawElement, index) => {
        const transformed = output[index];

        // Core identity preserved
        expect(transformed.eventId).toBe(eventId);
        expect(transformed.elementId).toBe(rawElement.id);

        // Stats correctly mapped
        expect(transformed.minutes).toBe(rawElement.stats.minutes);
        expect(transformed.goalsScored).toBe(rawElement.stats.goals_scored);
        expect(transformed.assists).toBe(rawElement.stats.assists);
        expect(transformed.cleanSheets).toBe(rawElement.stats.clean_sheets);
        expect(transformed.goalsConceded).toBe(rawElement.stats.goals_conceded);
        expect(transformed.ownGoals).toBe(rawElement.stats.own_goals);
        expect(transformed.penaltiesSaved).toBe(rawElement.stats.penalties_saved);
        expect(transformed.penaltiesMissed).toBe(rawElement.stats.penalties_missed);
        expect(transformed.yellowCards).toBe(rawElement.stats.yellow_cards);
        expect(transformed.redCards).toBe(rawElement.stats.red_cards);
        expect(transformed.saves).toBe(rawElement.stats.saves);
        expect(transformed.bonus).toBe(rawElement.stats.bonus);
        expect(transformed.bps).toBe(rawElement.stats.bps);
        expect(transformed.totalPoints).toBe(rawElement.stats.total_points);
        expect(transformed.inDreamTeam).toBe(rawElement.stats.in_dreamteam);

        // Expected values
        expect(transformed.expectedGoals).toBe(rawElement.stats.expected_goals);
        expect(transformed.expectedAssists).toBe(rawElement.stats.expected_assists);
        expect(transformed.expectedGoalInvolvements).toBe(
          rawElement.stats.expected_goal_involvements,
        );
        expect(transformed.expectedGoalsConceded).toBe(rawElement.stats.expected_goals_conceded);

        // Starts conversion
        expect(transformed.starts).toBe(rawElement.stats.starts > 0);
      });
    });

    test('should maintain immutability', () => {
      const eventId = 15;
      const originalInput = [...rawFPLEventLiveElementsFixture];
      const output1 = transformEventLives(eventId, rawFPLEventLiveElementsFixture);
      const output2 = transformEventLives(eventId, rawFPLEventLiveElementsFixture);

      // Outputs should be equal
      expect(output2).toEqual(output1);

      // Original input should be unchanged
      expect(rawFPLEventLiveElementsFixture).toEqual(originalInput);
    });
  });

  describe('Performance Tests', () => {
    test('should handle concurrent transformations', () => {
      const eventId = 15;
      const datasets = Array(10).fill(rawFPLEventLiveElementsFixture);

      const startTime = performance.now();
      const results = datasets.map((dataset) => transformEventLives(eventId, dataset));
      const endTime = performance.now();

      expect(results.length).toBe(10);
      results.forEach((result) => {
        expect(result.length).toBe(3);
      });

      expect(endTime - startTime).toBeLessThan(50); // Should be very fast
    });

    test('should handle memory efficiently with large datasets', () => {
      const eventId = 15;
      const largeDataset = Array(5000)
        .fill(singleRawEventLiveElementFixture)
        .map((element, index) => ({
          ...element,
          id: index + 1,
        }));

      const startTime = performance.now();
      const result = transformEventLives(eventId, largeDataset);
      const endTime = performance.now();

      expect(result).toHaveLength(5000);
      expect(endTime - startTime).toBeLessThan(500); // Should complete in under 500ms

      // Check memory isn't being wasted
      expect(result[0].elementId).toBe(1);
      expect(result[4999].elementId).toBe(5000);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    test('should handle negative total points', () => {
      const result = transformEventLive(15, {
        ...singleRawEventLiveElementFixture,
        stats: {
          ...singleRawEventLiveElementFixture.stats,
          total_points: -3,
        },
      });

      expect(result.totalPoints).toBe(-3);
    });

    test('should handle maximum minutes', () => {
      const result = transformEventLive(15, {
        ...singleRawEventLiveElementFixture,
        stats: {
          ...singleRawEventLiveElementFixture.stats,
          minutes: 90,
        },
      });

      expect(result.minutes).toBe(90);
    });

    test('should handle extra time minutes', () => {
      const result = transformEventLive(15, {
        ...singleRawEventLiveElementFixture,
        stats: {
          ...singleRawEventLiveElementFixture.stats,
          minutes: 120, // Extra time
        },
      });

      expect(result.minutes).toBe(120);
    });

    test('should handle multiple yellow cards', () => {
      const result = transformEventLive(15, {
        ...singleRawEventLiveElementFixture,
        stats: {
          ...singleRawEventLiveElementFixture.stats,
          yellow_cards: 2,
        },
      });

      expect(result.yellowCards).toBe(2);
    });

    test('should handle very high BPS', () => {
      const result = transformEventLive(15, {
        ...singleRawEventLiveElementFixture,
        stats: {
          ...singleRawEventLiveElementFixture.stats,
          bps: 100,
        },
      });

      expect(result.bps).toBe(100);
    });
  });
});
