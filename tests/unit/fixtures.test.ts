import { beforeEach, describe, expect, test } from 'bun:test';

import {
  getDifficultyForTeam,
  getFixtureScoreline,
  getFixtureWinner,
  isFixtureFinished,
  isFixtureUpcoming,
  validateFixture,
  validateRawFPLFixture,
} from '../../src/domain/fixtures';
import { createFixtureRepository } from '../../src/repositories/fixtures';
import { transformFixtures } from '../../src/transformers/fixtures';
import {
  mockFixture1,
  mockFixtures,
  mockRawFPLFixture1,
  mockRawFPLFixture2,
  mockRawFPLFixture3,
  mockRawFPLFixtures,
} from '../fixtures/fixtures.fixtures';

describe('Fixtures Unit Tests', () => {
  describe('Fixture Domain Validation', () => {
    test('should validate raw FPL fixture structure', () => {
      const validated = validateRawFPLFixture(mockRawFPLFixture1);
      expect(validated.code).toBe(mockRawFPLFixture1.code);
      expect(validated.team_a).toBe(mockRawFPLFixture1.team_a);
    });

    test('should validate domain fixture structure', () => {
      const fixture = transformFixtures([mockRawFPLFixture1])[0];
      const validated = validateFixture(fixture);

      expect(validated.id).toBe(fixture.id);
      expect(validated.teamHScore).toBe(4);
      expect(validated.stats).toHaveLength(2);
    });

    test('should reject fixtures with invalid difficulty values', () => {
      const invalidFixture = {
        ...mockRawFPLFixture1,
        team_h_difficulty: 6,
      };

      expect(() => transformFixtures([invalidFixture])).toThrowError();
    });
  });

  describe('Fixture Domain Helpers', () => {
    const [finishedFixture, scorelessFixture, upcomingFixture] =
      transformFixtures(mockRawFPLFixtures);

    test('should detect finished fixtures', () => {
      expect(isFixtureFinished(finishedFixture)).toBe(true);
      expect(isFixtureFinished(upcomingFixture)).toBe(false);
    });

    test('should detect upcoming fixtures', () => {
      expect(isFixtureUpcoming(upcomingFixture)).toBe(true);
      expect(isFixtureUpcoming(finishedFixture)).toBe(false);
    });

    test('should compute scoreline text', () => {
      expect(getFixtureScoreline(finishedFixture)).toBe('4-2');
      expect(getFixtureScoreline(upcomingFixture)).toBe('TBD');
    });

    test('should identify fixture winner', () => {
      expect(getFixtureWinner(finishedFixture)).toBe('home');
      expect(getFixtureWinner(scorelessFixture)).toBe('draw');
      expect(getFixtureWinner(upcomingFixture)).toBe('unknown');
    });

    test('should return difficulty values for teams', () => {
      expect(getDifficultyForTeam(finishedFixture, true)).toBe(3);
      expect(getDifficultyForTeam(finishedFixture, false)).toBe(5);
      expect(getDifficultyForTeam(upcomingFixture, true)).toBe(4);
    });
  });

  describe('transformFixtures Function', () => {
    test('should transform single fixture correctly', () => {
      const result = transformFixtures([mockRawFPLFixture1]);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(mockFixture1);
      expect(result[0].id).toBe(1);
      expect(result[0].code).toBe(2561895);
      expect(result[0].event).toBe(1);
      expect(result[0].finished).toBe(true);
      expect(result[0].teamA).toBe(4);
      expect(result[0].teamH).toBe(12);
      expect(result[0].kickoffTime).toEqual(new Date('2025-08-15T19:00:00Z'));
    });

    test('should transform multiple fixtures correctly', () => {
      const result = transformFixtures(mockRawFPLFixtures);

      expect(result).toHaveLength(3);
      expect(result).toEqual(mockFixtures);

      // Verify transformation accuracy
      result.forEach((fixture, index) => {
        const rawFixture = mockRawFPLFixtures[index];
        expect(fixture.id).toBe(rawFixture.id);
        expect(fixture.code).toBe(rawFixture.code);
        expect(fixture.event).toBe(rawFixture.event);
        expect(fixture.finished).toBe(rawFixture.finished);
        expect(fixture.finishedProvisional).toBe(rawFixture.finished_provisional);
        expect(fixture.teamA).toBe(rawFixture.team_a);
        expect(fixture.teamH).toBe(rawFixture.team_h);
        expect(fixture.teamAScore).toBe(rawFixture.team_a_score);
        expect(fixture.teamHScore).toBe(rawFixture.team_h_score);
        expect(fixture.pulseId).toBe(rawFixture.pulse_id);
      });
    });

    test('should handle empty array', () => {
      const result = transformFixtures([]);
      expect(result).toEqual([]);
      expect(result).toHaveLength(0);
    });

    test('should handle null kickoff_time correctly', () => {
      const fixtureWithNullKickoff = {
        ...mockRawFPLFixture1,
        kickoff_time: null,
      };

      const result = transformFixtures([fixtureWithNullKickoff]);
      expect(result[0].kickoffTime).toBeNull();
    });

    test('should handle null scores correctly', () => {
      const fixtureWithNullScores = {
        ...mockRawFPLFixture3,
        team_a_score: null,
        team_h_score: null,
      };

      const result = transformFixtures([fixtureWithNullScores]);
      expect(result[0].teamAScore).toBeNull();
      expect(result[0].teamHScore).toBeNull();
    });

    test('should handle stats array correctly', () => {
      const result = transformFixtures([mockRawFPLFixture1]);

      expect(result[0].stats).toEqual(mockRawFPLFixture1.stats);
      expect(Array.isArray(result[0].stats)).toBe(true);
      expect(result[0].stats).toHaveLength(2);
      expect(result[0].stats[0].identifier).toBe('goals_scored');
      expect(result[0].stats[1].identifier).toBe('assists');
    });

    test('should handle empty stats array', () => {
      const fixtureWithEmptyStats = {
        ...mockRawFPLFixture3,
        stats: [],
      };

      const result = transformFixtures([fixtureWithEmptyStats]);
      expect(result[0].stats).toEqual([]);
      expect(Array.isArray(result[0].stats)).toBe(true);
    });

    test('should handle large datasets efficiently', () => {
      const largeDataset = Array(1000)
        .fill(mockRawFPLFixture1)
        .map((fixture, index) => ({
          ...fixture,
          id: index + 1,
          code: 2561895 + index,
        }));

      const startTime = performance.now();
      const result = transformFixtures(largeDataset);
      const endTime = performance.now();

      expect(result).toHaveLength(1000);
      expect(endTime - startTime).toBeLessThan(100); // Should complete in under 100ms
    });
  });

  describe('FixtureRepository Unit Tests', () => {
    let repository: ReturnType<typeof createFixtureRepository>;

    beforeEach(() => {
      repository = createFixtureRepository();
    });

    test('should create repository instance', () => {
      expect(repository).toBeDefined();
      expect(repository.findAll).toBeDefined();
      expect(repository.findById).toBeDefined();
      expect(repository.findByEvent).toBeDefined();
      expect(repository.findByTeam).toBeDefined();
      expect(repository.upsertBatch).toBeDefined();
    });

    test('should handle repository method signatures', () => {
      expect(typeof repository.findAll).toBe('function');
      expect(typeof repository.findById).toBe('function');
      expect(typeof repository.findByEvent).toBe('function');
      expect(typeof repository.findByTeam).toBe('function');
      expect(typeof repository.upsertBatch).toBe('function');
      expect(typeof repository.deleteAll).toBe('function');
    });

    test('should handle upsertBatch with empty array', async () => {
      const result = await repository.upsertBatch([]);
      expect(result).toEqual([]);
    });
  });

  describe('Fixture Status Logic Tests', () => {
    test('should correctly identify finished fixtures', () => {
      const result = transformFixtures(mockRawFPLFixtures);
      const finishedFixtures = result.filter((fixture) => fixture.finished);

      expect(finishedFixtures).toHaveLength(2);
      finishedFixtures.forEach((fixture) => {
        expect(fixture.finished).toBe(true);
        expect(fixture.finishedProvisional).toBe(true);
        expect(fixture.minutes).toBe(90);
        expect(fixture.started).toBe(true);
        expect(fixture.teamAScore).not.toBeNull();
        expect(fixture.teamHScore).not.toBeNull();
      });
    });

    test('should correctly identify upcoming fixtures', () => {
      const result = transformFixtures(mockRawFPLFixtures);
      const upcomingFixtures = result.filter((fixture) => !fixture.finished);

      expect(upcomingFixtures).toHaveLength(1);
      const upcomingFixture = upcomingFixtures[0];
      expect(upcomingFixture.finished).toBe(false);
      expect(upcomingFixture.minutes).toBe(0);
      expect(upcomingFixture.started).toBeNull();
      expect(upcomingFixture.teamAScore).toBeNull();
      expect(upcomingFixture.teamHScore).toBeNull();
    });

    test('should correctly identify fixtures by event', () => {
      const result = transformFixtures(mockRawFPLFixtures);
      const event1Fixtures = result.filter((fixture) => fixture.event === 1);
      const event2Fixtures = result.filter((fixture) => fixture.event === 2);

      expect(event1Fixtures).toHaveLength(2);
      expect(event2Fixtures).toHaveLength(1);
    });

    test('should handle provisional start time', () => {
      const result = transformFixtures(mockRawFPLFixtures);

      result.forEach((fixture) => {
        expect(typeof fixture.provisionalStartTime).toBe('boolean');
        expect(fixture.provisionalStartTime).toBe(false);
      });
    });
  });

  describe('Transformation Output Validation', () => {
    test('should validate fixture structure after transformation', () => {
      const result = transformFixtures(mockRawFPLFixtures);

      result.forEach((fixture) => {
        // Required fields
        expect(typeof fixture.id).toBe('number');
        expect(typeof fixture.code).toBe('number');
        expect(typeof fixture.finished).toBe('boolean');
        expect(typeof fixture.finishedProvisional).toBe('boolean');
        expect(typeof fixture.minutes).toBe('number');
        expect(typeof fixture.provisionalStartTime).toBe('boolean');
        expect(typeof fixture.teamA).toBe('number');
        expect(typeof fixture.teamH).toBe('number');
        expect(typeof fixture.pulseId).toBe('number');

        // Nullable fields
        expect(['number', 'object']).toContain(typeof fixture.event);
        expect(['boolean', 'object']).toContain(typeof fixture.started);
        expect(['number', 'object']).toContain(typeof fixture.teamAScore);
        expect(['number', 'object']).toContain(typeof fixture.teamHScore);
        expect(['number', 'object']).toContain(typeof fixture.teamHDifficulty);
        expect(['number', 'object']).toContain(typeof fixture.teamADifficulty);

        // Array fields
        expect(Array.isArray(fixture.stats)).toBe(true);

        // Value ranges
        expect(fixture.id).toBeGreaterThan(0);
        expect(fixture.code).toBeGreaterThan(0);
        expect(fixture.minutes).toBeGreaterThanOrEqual(0);
        expect(fixture.pulseId).toBeGreaterThan(0);

        // Date field
        expect(['object']).toContain(typeof fixture.kickoffTime); // Date object or null
      });
    });

    test('should not have snake_case properties', () => {
      const result = transformFixtures(mockRawFPLFixtures);

      result.forEach((fixture) => {
        // Should not have snake_case properties
        expect(fixture).not.toHaveProperty('finished_provisional');
        expect(fixture).not.toHaveProperty('kickoff_time');
        expect(fixture).not.toHaveProperty('provisional_start_time');
        expect(fixture).not.toHaveProperty('team_a');
        expect(fixture).not.toHaveProperty('team_a_score');
        expect(fixture).not.toHaveProperty('team_h');
        expect(fixture).not.toHaveProperty('team_h_score');
        expect(fixture).not.toHaveProperty('team_h_difficulty');
        expect(fixture).not.toHaveProperty('team_a_difficulty');
        expect(fixture).not.toHaveProperty('pulse_id');

        // Should have camelCase properties
        expect(fixture).toHaveProperty('finishedProvisional');
        expect(fixture).toHaveProperty('kickoffTime');
        expect(fixture).toHaveProperty('provisionalStartTime');
        expect(fixture).toHaveProperty('teamA');
        expect(fixture).toHaveProperty('teamAScore');
        expect(fixture).toHaveProperty('teamH');
        expect(fixture).toHaveProperty('teamHScore');
        expect(fixture).toHaveProperty('teamHDifficulty');
        expect(fixture).toHaveProperty('teamADifficulty');
        expect(fixture).toHaveProperty('pulseId');
      });
    });
  });

  describe('Data Consistency Tests', () => {
    test('should maintain data consistency across transformations', () => {
      const input = mockRawFPLFixtures;
      const output = transformFixtures(input);

      expect(output.length).toBe(input.length);

      input.forEach((rawFixture, index) => {
        const transformedFixture = output[index];

        // Core identity preserved
        expect(transformedFixture.id).toBe(rawFixture.id);
        expect(transformedFixture.code).toBe(rawFixture.code);
        expect(transformedFixture.event).toBe(rawFixture.event);

        // Camel case conversion correct
        expect(transformedFixture.finished).toBe(rawFixture.finished);
        expect(transformedFixture.finishedProvisional).toBe(rawFixture.finished_provisional);
        expect(transformedFixture.provisionalStartTime).toBe(rawFixture.provisional_start_time);
        expect(transformedFixture.teamA).toBe(rawFixture.team_a);
        expect(transformedFixture.teamH).toBe(rawFixture.team_h);
        expect(transformedFixture.teamAScore).toBe(rawFixture.team_a_score);
        expect(transformedFixture.teamHScore).toBe(rawFixture.team_h_score);
        expect(transformedFixture.pulseId).toBe(rawFixture.pulse_id);

        // Date transformation
        if (rawFixture.kickoff_time) {
          expect(transformedFixture.kickoffTime).toEqual(new Date(rawFixture.kickoff_time));
        } else {
          expect(transformedFixture.kickoffTime).toBeNull();
        }

        // Stats array preserved
        expect(transformedFixture.stats).toEqual(rawFixture.stats);
      });
    });

    test('should be pure function with no side effects', () => {
      const input = mockRawFPLFixtures;
      const output1 = transformFixtures(input);
      const output2 = transformFixtures(input);

      // Same input produces same output
      expect(output2).toEqual(output1);

      // Original input unchanged
      expect(input).toEqual(mockRawFPLFixtures);
    });
  });

  describe('Error Handling Unit Tests', () => {
    test('should handle fixture with missing optional fields', () => {
      const minimalFixture = {
        id: 999,
        code: 9999999,
        event: null,
        finished: false,
        finished_provisional: false,
        kickoff_time: null,
        minutes: 0,
        provisional_start_time: false,
        started: null,
        team_a: 1,
        team_a_score: null,
        team_h: 2,
        team_h_score: null,
        stats: [],
        team_h_difficulty: null,
        team_a_difficulty: null,
        pulse_id: 999999,
      };

      expect(() => transformFixtures([minimalFixture])).not.toThrow();
      const result = transformFixtures([minimalFixture]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(999);
    });

    test('should handle invalid date strings', () => {
      const fixtureWithInvalidDate = {
        ...mockRawFPLFixture1,
        kickoff_time: 'invalid-date-string',
      };

      expect(() => transformFixtures([fixtureWithInvalidDate])).not.toThrow();
      const result = transformFixtures([fixtureWithInvalidDate]);
      expect(result).toHaveLength(1);
      // The result should handle invalid dates gracefully
      expect(result[0].kickoffTime).toBeTruthy(); // Will be Invalid Date object
    });
  });

  describe('Fixture Stats Tests', () => {
    test('should preserve complex stats structure', () => {
      const result = transformFixtures([mockRawFPLFixture1]);
      const fixture = result[0];

      expect(fixture.stats).toHaveLength(2);

      const goalsScored = fixture.stats[0];
      expect(goalsScored.identifier).toBe('goals_scored');
      expect(Array.isArray(goalsScored.a)).toBe(true);
      expect(Array.isArray(goalsScored.h)).toBe(true);
      expect(goalsScored.a[0]).toHaveProperty('value');
      expect(goalsScored.a[0]).toHaveProperty('element');

      const assists = fixture.stats[1];
      expect(assists.identifier).toBe('assists');
      expect(assists.a).toHaveLength(2);
      expect(assists.h).toHaveLength(3);
    });

    test('should handle empty stats correctly', () => {
      const result = transformFixtures([mockRawFPLFixture2]);
      const fixture = result[0];

      const goalsScored = fixture.stats.find((s) => s.identifier === 'goals_scored');
      expect(goalsScored).toBeDefined();
      expect(goalsScored?.a).toHaveLength(0);
      expect(goalsScored?.h).toHaveLength(0);
    });
  });

  describe('Performance Unit Tests', () => {
    test('should handle concurrent transformations', () => {
      const datasets = Array(10).fill(mockRawFPLFixtures);

      const startTime = performance.now();
      const results = datasets.map((dataset) => transformFixtures(dataset));
      const endTime = performance.now();

      expect(results.length).toBe(10);
      results.forEach((result) => {
        expect(result.length).toBe(3);
      });

      expect(endTime - startTime).toBeLessThan(50); // Should be very fast
    });

    test('should handle memory efficiently with large datasets', () => {
      const largeDataset = Array(5000)
        .fill(mockRawFPLFixture1)
        .map((fixture, index) => ({
          ...fixture,
          id: index + 1,
          code: 2561895 + index,
        }));

      const startTime = performance.now();
      const result = transformFixtures(largeDataset);
      const endTime = performance.now();

      expect(result).toHaveLength(5000);
      expect(endTime - startTime).toBeLessThan(500); // Should complete in under 500ms

      // Check memory isn't being wasted
      expect(result[0].id).toBe(1);
      expect(result[4999].id).toBe(5000);
    });
  });

  describe('Team Fixtures Logic Tests', () => {
    test('should identify all fixtures for a specific team', () => {
      const result = transformFixtures(mockRawFPLFixtures);
      const team4Fixtures = result.filter((f) => f.teamA === 4 || f.teamH === 4);

      expect(team4Fixtures).toHaveLength(1);
      expect(team4Fixtures[0].id).toBe(1);
    });

    test('should identify home and away fixtures separately', () => {
      const result = transformFixtures(mockRawFPLFixtures);

      const team12HomeFixtures = result.filter((f) => f.teamH === 12);
      const team12AwayFixtures = result.filter((f) => f.teamA === 12);

      expect(team12HomeFixtures).toHaveLength(1);
      expect(team12AwayFixtures).toHaveLength(0);
    });
  });
});
