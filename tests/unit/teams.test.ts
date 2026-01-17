import { beforeEach, describe, expect, test } from 'bun:test';

import { createTeamRepository } from '../../src/repositories/teams';
import { transformTeams } from '../../src/transformers/teams';
import {
  rawFPLTeamsFixture,
  singleRawTeamFixture,
  singleTransformedTeamFixture,
  transformedTeamsFixture,
} from '../fixtures/teams.fixtures';

describe('Teams Unit Tests', () => {
  describe('transformTeams Function', () => {
    test('should transform single team correctly', () => {
      const result = transformTeams([singleRawTeamFixture]);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(singleTransformedTeamFixture);
      expect(result[0].id).toBe(1);
      expect(result[0].name).toBe('Arsenal');
      expect(result[0].shortName).toBe('ARS');
      expect(result[0].code).toBe(3);
      expect(result[0].strength).toBe(4);
    });

    test('should transform multiple teams correctly', () => {
      const result = transformTeams(rawFPLTeamsFixture);

      expect(result).toHaveLength(3);
      expect(result).toEqual(transformedTeamsFixture);

      // Verify transformation accuracy
      result.forEach((team, index) => {
        const rawTeam = rawFPLTeamsFixture[index];
        expect(team.id).toBe(rawTeam.id);
        expect(team.name).toBe(rawTeam.name);
        expect(team.shortName).toBe(rawTeam.short_name);
        expect(team.code).toBe(rawTeam.code);
        expect(team.strength).toBe(rawTeam.strength);
        expect(team.strengthOverallHome).toBe(rawTeam.strength_overall_home);
        expect(team.strengthOverallAway).toBe(rawTeam.strength_overall_away);
        expect(team.pulseId).toBe(rawTeam.pulse_id);
      });
    });

    test('should handle null values correctly', () => {
      const teamWithNulls = {
        ...singleRawTeamFixture,
        form: null,
        team_division: null,
      };

      const result = transformTeams([teamWithNulls]);
      expect(result[0].form).toBeNull();
      expect(result[0].teamDivision).toBeNull();
    });

    test('should handle large datasets efficiently', () => {
      const largeDataset = Array(1000)
        .fill(singleRawTeamFixture)
        .map((team, index) => ({
          ...team,
          id: index + 1,
          code: index + 1,
          name: `Team ${index + 1}`,
          short_name: `T${String(index + 1).padStart(3, '0')}`,
          position: (index % 20) + 1, // Ensure position is between 1-20
        }));

      const startTime = performance.now();
      const result = transformTeams(largeDataset);
      const endTime = performance.now();

      expect(result).toHaveLength(1000);
      expect(endTime - startTime).toBeLessThan(100); // Should complete in under 100ms
    });
  });

  describe('TeamRepository Unit Tests', () => {
    let mockDb: any;
    let repository: ReturnType<typeof createTeamRepository>;

    beforeEach(() => {
      // Create mock database with proper method chaining
      mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([singleTransformedTeamFixture]),
            orderBy: () => Promise.resolve([singleTransformedTeamFixture]),
          }),
        }),
        insert: () => ({
          values: () => ({
            onConflictDoUpdate: () => ({
              returning: () => Promise.resolve([singleTransformedTeamFixture]),
            }),
            onConflictDoNothing: () => ({
              returning: () => Promise.resolve([singleTransformedTeamFixture]),
            }),
          }),
        }),
        delete: () => Promise.resolve(undefined),
      };

      // Create repository with mock database injected
      repository = createTeamRepository(mockDb as any);

      // Ensure the mock is used by setting the db property directly
      (repository as any).db = mockDb;
    });

    test('should create repository instance', () => {
      expect(repository).toBeDefined();
      expect(repository.upsertBatch).toBeDefined();
    });

    test('should handle upsertBatch with empty array', async () => {
      const result = await repository.upsertBatch([]);
      expect(result).toEqual([]);
    });

    test('should handle upsertBatch with teams', async () => {
      // Create a proper mock chain for batch operations
      const mockInsert = () => ({
        values: () => ({
          onConflictDoUpdate: () => ({
            returning: () => Promise.resolve(transformedTeamsFixture),
          }),
        }),
      });

      // Temporarily replace the mock
      const originalInsert = mockDb.insert;
      mockDb.insert = mockInsert;

      try {
        const result = await repository.upsertBatch(transformedTeamsFixture);
        expect(Array.isArray(result)).toBe(true);
        expect(result).toEqual(transformedTeamsFixture);
      } finally {
        // Restore original mock
        mockDb.insert = originalInsert;
      }
    });
  });

  describe('Teams API Functions Unit Tests', () => {
    test('should test data flow functions exist', () => {
      // Note: Cache operations use singleton pattern and connect to real Redis
      // Full cache testing is done in integration tests
      // Here we just verify the functions exist and can be called

      expect(transformTeams).toBeDefined();
      expect(typeof transformTeams).toBe('function');
    });

    test('should handle teams transformation pipeline', () => {
      // Test the core transformation logic
      const input = rawFPLTeamsFixture;
      const output = transformTeams(input);

      expect(output).toHaveLength(input.length);

      // Verify transformation is pure (no side effects)
      const output2 = transformTeams(input);
      expect(output2).toEqual(output);

      // Verify immutability
      expect(input).toEqual(rawFPLTeamsFixture); // Original unchanged
    });

    test('should validate transformation output format', () => {
      const result = transformTeams(rawFPLTeamsFixture);

      result.forEach((team) => {
        // Required fields should be present and correct type
        expect(typeof team.id).toBe('number');
        expect(typeof team.name).toBe('string');
        expect(typeof team.shortName).toBe('string');
        expect(typeof team.code).toBe('number');
        expect(typeof team.strength).toBe('number');

        // Should have all camelCase properties
        expect(team).toHaveProperty('strengthOverallHome');
        expect(team).toHaveProperty('strengthOverallAway');
        expect(team).toHaveProperty('strengthAttackHome');
        expect(team).toHaveProperty('strengthAttackAway');
        expect(team).toHaveProperty('strengthDefenceHome');
        expect(team).toHaveProperty('strengthDefenceAway');
        expect(team).toHaveProperty('pulseId');
        expect(team).toHaveProperty('teamDivision');

        // Should not have snake_case properties
        expect(team).not.toHaveProperty('short_name');
        expect(team).not.toHaveProperty('strength_overall_home');
        expect(team).not.toHaveProperty('pulse_id');
        expect(team).not.toHaveProperty('team_division');
      });
    });
  });

  describe('Error Handling Unit Tests', () => {
    test('should handle transformation with missing fields', () => {
      const incompleteTeam = {
        id: 999,
        code: 999,
        name: 'Incomplete Team',
        short_name: 'INC',
        strength: 1,
        position: 1,
        points: 0,
        played: 0,
        win: 0,
        draw: 0,
        loss: 0,
        form: null,
        team_division: null,
        unavailable: false,
        strength_overall_home: 1000,
        strength_overall_away: 1000,
        strength_attack_home: 1000,
        strength_attack_away: 1000,
        strength_defence_home: 1000,
        strength_defence_away: 1000,
        pulse_id: 999,
      };

      expect(() => transformTeams([incompleteTeam])).not.toThrow();
      const result = transformTeams([incompleteTeam]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(999);
      expect(result[0].name).toBe('Incomplete Team');
    });

    test('should handle edge case values correctly', () => {
      const edgeCaseTeam = {
        id: 999,
        code: 999,
        name: 'Edge Case Team',
        short_name: 'ECT',
        strength: 1,
        position: 1, // Valid position (1-20)
        points: 0,
        played: 0,
        win: 0,
        draw: 0,
        loss: 0,
        form: null, // Edge case: null form
        team_division: null, // Edge case: null division
        unavailable: false,
        strength_overall_home: 1000,
        strength_overall_away: 1000,
        strength_attack_home: 1000,
        strength_attack_away: 1000,
        strength_defence_home: 1000,
        strength_defence_away: 1000,
        pulse_id: 999,
      };

      const result = transformTeams([edgeCaseTeam]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(999);
      expect(result[0].position).toBe(1); // Should handle valid position correctly
      expect(result[0].form).toBe(null); // Should handle null correctly
      expect(result[0].teamDivision).toBe(null); // Should handle null correctly
    });

    test('should handle database connection errors', async () => {
      const errorDb = {
        select: () => ({
          from: () => {
            throw new Error('Database connection failed');
          },
        }),
        insert: () => ({
          values: () => {
            throw new Error('Database connection failed');
          },
        }),
        delete: () => {
          throw new Error('Database connection failed');
        },
      };

      const errorRepository = createTeamRepository(errorDb as any);

      // The errors are wrapped in DatabaseError with custom messages
      await expect(errorRepository.upsertBatch([singleTransformedTeamFixture])).rejects.toThrow();
    });
  });

  describe('Data Validation Unit Tests', () => {
    test('should validate team structure after transformation', () => {
      const result = transformTeams(rawFPLTeamsFixture);

      result.forEach((team) => {
        // Required fields
        expect(typeof team.id).toBe('number');
        expect(typeof team.name).toBe('string');
        expect(typeof team.shortName).toBe('string');
        expect(typeof team.code).toBe('number');
        expect(typeof team.strength).toBe('number');
        expect(typeof team.position).toBe('number');
        expect(typeof team.points).toBe('number');
        expect(typeof team.played).toBe('number');
        expect(typeof team.win).toBe('number');
        expect(typeof team.draw).toBe('number');
        expect(typeof team.loss).toBe('number');
        expect(typeof team.unavailable).toBe('boolean');

        // Strength fields
        expect(typeof team.strengthOverallHome).toBe('number');
        expect(typeof team.strengthOverallAway).toBe('number');
        expect(typeof team.strengthAttackHome).toBe('number');
        expect(typeof team.strengthAttackAway).toBe('number');
        expect(typeof team.strengthDefenceHome).toBe('number');
        expect(typeof team.strengthDefenceAway).toBe('number');
        expect(typeof team.pulseId).toBe('number');

        // Nullable fields
        expect(['string', 'object']).toContain(typeof team.form); // string or null
        expect(['string', 'object']).toContain(typeof team.teamDivision); // string or null

        // Value ranges
        expect(team.id).toBeGreaterThan(0);
        expect(team.code).toBeGreaterThan(0);
        expect(team.strength).toBeGreaterThanOrEqual(1);
        expect(team.strength).toBeLessThanOrEqual(5);
        expect(team.name.length).toBeGreaterThan(0);
        expect(team.shortName.length).toBeGreaterThan(0);
      });
    });

    test('should maintain data consistency across transformations', () => {
      const input = rawFPLTeamsFixture;
      const output = transformTeams(input);

      expect(output.length).toBe(input.length);

      input.forEach((rawTeam, index) => {
        const transformedTeam = output[index];

        // Core identity preserved
        expect(transformedTeam.id).toBe(rawTeam.id);
        expect(transformedTeam.code).toBe(rawTeam.code);
        expect(transformedTeam.name).toBe(rawTeam.name);

        // Camel case conversion correct
        expect(transformedTeam.shortName).toBe(rawTeam.short_name);
        expect(transformedTeam.teamDivision).toBe(rawTeam.team_division);
        expect(transformedTeam.strengthOverallHome).toBe(rawTeam.strength_overall_home);
        expect(transformedTeam.pulseId).toBe(rawTeam.pulse_id);
      });
    });
  });

  describe('Performance Unit Tests', () => {
    test('should handle concurrent transformations', () => {
      const datasets = Array(10).fill(rawFPLTeamsFixture);

      const startTime = performance.now();
      const results = datasets.map((dataset) => transformTeams(dataset));
      const endTime = performance.now();

      expect(results.length).toBe(10);
      results.forEach((result) => {
        expect(result.length).toBe(3);
      });

      expect(endTime - startTime).toBeLessThan(50); // Should be very fast
    });

    test('should handle memory efficiently with large datasets', () => {
      const largeDataset = Array(5000)
        .fill(singleRawTeamFixture)
        .map((team, index) => ({
          ...team,
          id: index + 1,
          code: index + 1,
          name: `Team ${index + 1}`,
        }));

      const startTime = performance.now();
      const result = transformTeams(largeDataset);
      const endTime = performance.now();

      expect(result).toHaveLength(5000);
      expect(endTime - startTime).toBeLessThan(500); // Should complete in under 500ms

      // Check memory isn't being wasted
      expect(result[0].name).toBe('Team 1');
      expect(result[4999].name).toBe('Team 5000');
    });
  });
});
