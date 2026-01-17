import { beforeEach, describe, expect, test } from 'bun:test';

import type { ElementTypeId } from '../../src/types/base.type';

import {
  filterPlayerStatsByPosition,
  filterPlayerStatsByTeam,
  getAttackingReturns,
  getDefensiveReturns,
  getExpectedAssistsAsNumber,
  getExpectedGoalsAsNumber,
  getFormAsNumber,
  getFormRating,
  getIctIndexAsNumber,
  getPointsPerMillion,
  hasGoodValue,
  isDifferentialPick,
  isRegularStarter,
  sortPlayerStatsByPoints,
  sortPlayerStatsByPointsPerMillion,
  sortPlayerStatsByValue,
  validatePlayerStat,
  validatePlayerStats,
  validateRawPlayerStat,
} from '../../src/domain/player-stats';
import { PlayerStatsRepository } from '../../src/repositories/player-stats';
import {
  createTeamsMap,
  extractPlayerIds,
  groupPlayerStatsByPosition,
  groupPlayerStatsByTeam,
  safeTransformPlayerStat,
  transformPlayerStat,
  transformPlayerStats,
  transformPlayerStatsStrict,
} from '../../src/transformers/player-stats';
import {
  defPlayerStatFixture,
  fwdPlayerStatFixture,
  generatePlayerStat,
  generatePlayerStats,
  gkpPlayerStatFixture,
  midPlayerStatFixture,
  mockTeamsForPlayerStats,
  rawFPLElementsFixture,
  singlePlayerStatFixture,
  singleRawElementFixture,
  transformedPlayerStatsFixture,
} from '../fixtures/player-stats.fixtures';

describe('Player Stats Unit Tests', () => {
  describe('Domain Logic Tests', () => {
    describe('Validation Functions', () => {
      test('should validate player stat correctly', () => {
        expect(() => validatePlayerStat(singlePlayerStatFixture)).not.toThrow();
        const validatedStat = validatePlayerStat(singlePlayerStatFixture);
        expect(validatedStat).toEqual(singlePlayerStatFixture);
      });

      test('should validate raw player stat correctly', () => {
        const rawStat = {
          eventId: 3,
          elementId: 1,
          elementType: 1 as ElementTypeId,
          totalPoints: 42,
          form: '4.2',
          influence: '78.2',
          creativity: '12.4',
          threat: '5.1',
          ictIndex: '9.6',
          expectedGoals: '0.12',
          expectedAssists: '0.45',
          expectedGoalInvolvements: '0.57',
          expectedGoalsConceded: '14.2',
          minutes: 990,
          goalsScored: 0,
          assists: 1,
          cleanSheets: 6,
          goalsConceded: 12,
          ownGoals: 0,
          penaltiesSaved: 1,
          yellowCards: 2,
          redCards: 0,
          saves: 45,
          bonus: 3,
          bps: 156,
          starts: null,
          influenceRank: null,
          influenceRankType: null,
          creativityRank: null,
          creativityRankType: null,
          threatRank: null,
          threatRankType: null,
          ictIndexRank: null,
          ictIndexRankType: null,
        };

        expect(() => validateRawPlayerStat(rawStat)).not.toThrow();
        const validatedRawStat = validateRawPlayerStat(rawStat);
        expect(validatedRawStat).toEqual(rawStat);
      });

      test('should validate array of player stats', () => {
        expect(() => validatePlayerStats(transformedPlayerStatsFixture)).not.toThrow();
        const validatedStats = validatePlayerStats(transformedPlayerStatsFixture);
        expect(validatedStats).toHaveLength(transformedPlayerStatsFixture.length);
        expect(validatedStats).toEqual(transformedPlayerStatsFixture);
      });

      test('should reject invalid player stat data', () => {
        const invalidStat = {
          ...singlePlayerStatFixture,
          elementType: 5, // Invalid position
        };

        expect(() => validatePlayerStat(invalidStat)).toThrow();
      });
    });

    describe('Business Logic Functions', () => {
      test('should calculate points per million correctly', () => {
        const stat = generatePlayerStat({ value: 100, totalPoints: 150 }); // 10.0m, 150 points
        const ppm = getPointsPerMillion(stat);
        expect(ppm).toBe(15); // 150 / 10 = 15 points per million
      });

      test('should handle null total points for points per million', () => {
        const stat = generatePlayerStat({ totalPoints: null });
        const ppm = getPointsPerMillion(stat);
        expect(ppm).toBeNull();
      });

      test('should convert form string to number', () => {
        expect(getFormAsNumber(generatePlayerStat({ form: '5.2' }))).toBe(5.2);
        expect(getFormAsNumber(generatePlayerStat({ form: null }))).toBeNull();
        expect(getFormAsNumber(generatePlayerStat({ form: 'invalid' }))).toBeNull();
      });

      test('should rate form correctly', () => {
        expect(getFormRating(generatePlayerStat({ form: '5.5' }))).toBe('excellent');
        expect(getFormRating(generatePlayerStat({ form: '4.0' }))).toBe('good');
        expect(getFormRating(generatePlayerStat({ form: '2.5' }))).toBe('average');
        expect(getFormRating(generatePlayerStat({ form: '1.0' }))).toBe('poor');
        expect(getFormRating(generatePlayerStat({ form: null }))).toBe('unknown');
      });

      test('should convert expected goals to number', () => {
        expect(getExpectedGoalsAsNumber(generatePlayerStat({ expectedGoals: '2.45' }))).toBe(2.45);
        expect(getExpectedGoalsAsNumber(generatePlayerStat({ expectedGoals: null }))).toBeNull();
      });

      test('should convert expected assists to number', () => {
        expect(getExpectedAssistsAsNumber(generatePlayerStat({ expectedAssists: '1.75' }))).toBe(
          1.75,
        );
        expect(
          getExpectedAssistsAsNumber(generatePlayerStat({ expectedAssists: null })),
        ).toBeNull();
      });

      test('should convert ICT index to number', () => {
        expect(getIctIndexAsNumber(generatePlayerStat({ ictIndex: '45.6' }))).toBe(45.6);
        expect(getIctIndexAsNumber(generatePlayerStat({ ictIndex: null }))).toBeNull();
      });

      test('should identify regular starter', () => {
        const regularStarter = generatePlayerStat({ minutes: 1350, starts: 15 }); // 90 min average
        const nonRegularStarter = generatePlayerStat({ minutes: 500, starts: 15 }); // 33 min average

        expect(isRegularStarter(regularStarter)).toBe(true);
        expect(isRegularStarter(nonRegularStarter)).toBe(false);
      });

      test('should identify good value players', () => {
        const goodValue = generatePlayerStat({ value: 100, totalPoints: 150 }); // 15 points per million
        const poorValue = generatePlayerStat({ value: 100, totalPoints: 50 }); // 5 points per million

        expect(hasGoodValue(goodValue, 10)).toBe(true);
        expect(hasGoodValue(poorValue, 10)).toBe(false);
      });

      test('should calculate attacking returns', () => {
        const attacker = generatePlayerStat({ goalsScored: 5, assists: 3 });
        expect(getAttackingReturns(attacker)).toBe(8);

        const noReturns = generatePlayerStat({ goalsScored: null, assists: null });
        expect(getAttackingReturns(noReturns)).toBeNull();
      });

      test('should get defensive returns', () => {
        const goalkeeper = generatePlayerStat({ elementType: 1, saves: 45, cleanSheets: 6 });
        expect(getDefensiveReturns(goalkeeper)).toBe(45); // Saves for GKP

        const defender = generatePlayerStat({ elementType: 2, saves: 0, cleanSheets: 8 });
        expect(getDefensiveReturns(defender)).toBe(8); // Clean sheets for DEF
      });

      test('should identify differential picks', () => {
        const differential = generatePlayerStat({
          form: '4.0',
          value: 70, // 7.0m
          totalPoints: 80, // 11.4 points per million
        });
        const template = generatePlayerStat({
          form: '2.0', // Low form
          value: 70,
          totalPoints: 80,
        });

        expect(isDifferentialPick(differential)).toBe(true);
        expect(isDifferentialPick(template)).toBe(false);
      });
    });

    describe('Filtering and Sorting Functions', () => {
      test('should filter by position', () => {
        const gkps = filterPlayerStatsByPosition(transformedPlayerStatsFixture, 1);
        const defs = filterPlayerStatsByPosition(transformedPlayerStatsFixture, 2);
        const mids = filterPlayerStatsByPosition(transformedPlayerStatsFixture, 3);
        const fwds = filterPlayerStatsByPosition(transformedPlayerStatsFixture, 4);

        expect(gkps).toHaveLength(1);
        expect(defs).toHaveLength(1);
        expect(mids).toHaveLength(1);
        expect(fwds).toHaveLength(1);

        expect(gkps[0].elementType).toBe(1);
        expect(defs[0].elementType).toBe(2);
        expect(mids[0].elementType).toBe(3);
        expect(fwds[0].elementType).toBe(4);
      });

      test('should filter by team', () => {
        const arsenal = filterPlayerStatsByTeam(transformedPlayerStatsFixture, 1);
        const city = filterPlayerStatsByTeam(transformedPlayerStatsFixture, 2);
        const liverpool = filterPlayerStatsByTeam(transformedPlayerStatsFixture, 3);

        expect(arsenal).toHaveLength(2); // Ramsdale, Saliba
        expect(city).toHaveLength(1); // De Bruyne
        expect(liverpool).toHaveLength(1); // Salah

        arsenal.forEach((stat) => expect(stat.teamId).toBe(1));
        city.forEach((stat) => expect(stat.teamId).toBe(2));
        liverpool.forEach((stat) => expect(stat.teamId).toBe(3));
      });

      test('should sort by total points', () => {
        const sorted = sortPlayerStatsByPoints(transformedPlayerStatsFixture);

        // Should be in descending order: Salah (187), De Bruyne (156), Saliba (78), Ramsdale (42)
        expect(sorted[0].totalPoints).toBe(187);
        expect(sorted[1].totalPoints).toBe(156);
        expect(sorted[2].totalPoints).toBe(78);
        expect(sorted[3].totalPoints).toBe(42);
      });

      test('should sort by value (price)', () => {
        const sorted = sortPlayerStatsByValue(transformedPlayerStatsFixture);

        // Should be in ascending order: Ramsdale (50), Saliba (65), De Bruyne (125), Salah (135)
        expect(sorted[0].value).toBe(50);
        expect(sorted[1].value).toBe(65);
        expect(sorted[2].value).toBe(125);
        expect(sorted[3].value).toBe(135);
      });

      test('should sort by points per million', () => {
        const sorted = sortPlayerStatsByPointsPerMillion(transformedPlayerStatsFixture);

        // Calculate expected PPM: Salah (13.86), De Bruyne (12.48), Saliba (12.0), Ramsdale (8.4)
        expect(getPointsPerMillion(sorted[0])).toBeCloseTo(13.86, 1);
        expect(sorted[0].elementId).toBe(4); // Salah
      });
    });
  });

  describe('Transformer Functions Tests', () => {
    const teamsMap = createTeamsMap(mockTeamsForPlayerStats);

    describe('transformPlayerStat Function', () => {
      test('should transform single player stat correctly', () => {
        const result = transformPlayerStat(singleRawElementFixture, 3, teamsMap);

        expect(result).toEqual(singlePlayerStatFixture);
        expect(result.eventId).toBe(3);
        expect(result.elementId).toBe(1);
        expect(result.webName).toBe('Ramsdale');
        expect(result.elementType).toBe(1);
        expect(result.elementTypeName).toBe('GKP');
        expect(result.teamId).toBe(1);
        expect(result.teamName).toBe('Arsenal');
        expect(result.teamShortName).toBe('ARS');
      });

      test('should handle team mapping correctly', () => {
        const result = transformPlayerStat(rawFPLElementsFixture[2], 3, teamsMap); // De Bruyne

        expect(result.teamId).toBe(2);
        expect(result.teamName).toBe('Manchester City');
        expect(result.teamShortName).toBe('MCI');
      });

      test('should throw error for unknown team', () => {
        const elementWithUnknownTeam = {
          ...singleRawElementFixture,
          team: 999, // Non-existent team
        };

        expect(() => transformPlayerStat(elementWithUnknownTeam, 3, teamsMap)).toThrow(
          'Team not found',
        );
      });
    });

    describe('transformPlayerStats Function', () => {
      test('should transform multiple player stats correctly', () => {
        const result = transformPlayerStats(rawFPLElementsFixture, 3, teamsMap);

        expect(result).toHaveLength(4);

        result.forEach((stat, index) => {
          const rawElement = rawFPLElementsFixture[index];
          expect(stat.eventId).toBe(3);
          expect(stat.elementId).toBe(rawElement.id);
          expect(stat.webName).toBe(rawElement.web_name);
          expect(stat.elementType).toBe(rawElement.element_type as ElementTypeId);
          expect(stat.teamId).toBe(rawElement.team);
          expect(stat.value).toBe(rawElement.now_cost);
          expect(stat.totalPoints).toBe(rawElement.total_points);
          expect(stat.form).toBe(rawElement.form);
        });
      });

      test('should handle empty array', () => {
        const result = transformPlayerStats([], 3, teamsMap);
        expect(result).toEqual([]);
        expect(result).toHaveLength(0);
      });

      test('should handle transformation errors gracefully', () => {
        const invalidElement = {
          ...singleRawElementFixture,
          team: 999, // Non-existent team
        };
        const mixedData = [singleRawElementFixture, invalidElement];

        const result = transformPlayerStats(mixedData, 3, teamsMap);
        expect(result).toHaveLength(1); // Only valid element transformed
        expect(result[0]).toEqual(singlePlayerStatFixture);
      });
    });

    describe('transformPlayerStatsStrict Function', () => {
      test('should transform all or fail', () => {
        // Valid data should work
        expect(() => transformPlayerStatsStrict(rawFPLElementsFixture, 3, teamsMap)).not.toThrow();
        const result = transformPlayerStatsStrict(rawFPLElementsFixture, 3, teamsMap);
        expect(result).toHaveLength(4);

        // Invalid data should throw
        const invalidElement = { ...singleRawElementFixture, team: 999 };
        const invalidData = [singleRawElementFixture, invalidElement];
        expect(() => transformPlayerStatsStrict(invalidData, 3, teamsMap)).toThrow();
      });
    });

    describe('safeTransformPlayerStat Function', () => {
      test('should return null on transformation failure', () => {
        const invalidElement = { ...singleRawElementFixture, team: 999 };
        const result = safeTransformPlayerStat(invalidElement, 3, teamsMap);
        expect(result).toBeNull();
      });

      test('should return valid result on success', () => {
        const result = safeTransformPlayerStat(singleRawElementFixture, 3, teamsMap);
        expect(result).toEqual(singlePlayerStatFixture);
      });
    });

    describe('Helper Functions', () => {
      test('should create teams map correctly', () => {
        const teamsMap = createTeamsMap(mockTeamsForPlayerStats);

        expect(teamsMap.size).toBe(3);
        expect(teamsMap.get(1)).toEqual({ name: 'Arsenal', shortName: 'ARS' });
        expect(teamsMap.get(2)).toEqual({ name: 'Manchester City', shortName: 'MCI' });
        expect(teamsMap.get(3)).toEqual({ name: 'Liverpool', shortName: 'LIV' });
      });

      test('should extract unique player IDs', () => {
        const playerIds = extractPlayerIds(transformedPlayerStatsFixture);
        expect(playerIds).toEqual([1, 2, 3, 4]);
        expect(playerIds).toHaveLength(4);
      });

      test('should group by position', () => {
        const grouped = groupPlayerStatsByPosition(transformedPlayerStatsFixture);

        expect(grouped.GKP).toHaveLength(1);
        expect(grouped.DEF).toHaveLength(1);
        expect(grouped.MID).toHaveLength(1);
        expect(grouped.FWD).toHaveLength(1);

        expect(grouped.GKP[0].elementTypeName).toBe('GKP');
        expect(grouped.DEF[0].elementTypeName).toBe('DEF');
        expect(grouped.MID[0].elementTypeName).toBe('MID');
        expect(grouped.FWD[0].elementTypeName).toBe('FWD');
      });

      test('should group by team', () => {
        const grouped = groupPlayerStatsByTeam(transformedPlayerStatsFixture);

        expect(grouped[1]).toHaveLength(2); // Arsenal
        expect(grouped[2]).toHaveLength(1); // Manchester City
        expect(grouped[3]).toHaveLength(1); // Liverpool

        grouped[1].forEach((stat) => expect(stat.teamId).toBe(1));
        grouped[2].forEach((stat) => expect(stat.teamId).toBe(2));
        grouped[3].forEach((stat) => expect(stat.teamId).toBe(3));
      });
    });
  });

  describe('Repository Unit Tests', () => {
    let _mockDb: any;
    let repository: PlayerStatsRepository;

    beforeEach(() => {
      // Create mock database with simple functions
      _mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => Promise.resolve([singlePlayerStatFixture]),
            }),
            orderBy: () => Promise.resolve([singlePlayerStatFixture]),
          }),
        }),
        insert: () => ({
          values: () => ({
            onConflictDoUpdate: () => ({
              returning: () => Promise.resolve([singlePlayerStatFixture]),
            }),
          }),
        }),
        delete: () => Promise.resolve(undefined),
      };

      repository = new PlayerStatsRepository();
      // Note: Real repository uses singleton db, this is just for testing structure
    });

    test('should create repository instance', () => {
      expect(repository).toBeDefined();
      expect(repository.upsertBatch).toBeDefined();
    });

    test('should handle repository method signatures', () => {
      expect(typeof repository.upsertBatch).toBe('function');
    });

    test('should handle upsertBatch with empty array', async () => {
      const result = await repository.upsertBatch([]);
      expect(result).toEqual({ count: 0 });
    });
  });

  describe('Error Handling Unit Tests', () => {
    test('should handle transformation with missing fields', () => {
      const incompleteElement = {
        id: 999,
        web_name: 'Incomplete Player',
        element_type: 1,
        team: 1,
        now_cost: 50,
        code: 123456,
        cost_change_start: 0,
        cost_change_event: 0,
        cost_change_event_fall: 0,
        cost_change_start_fall: 0,
        first_name: 'Incomplete',
        second_name: 'Player',
        photo: 'jpg',
        status: 'a',
        selected_by_percent: '1.0',
        total_points: 10,
        points_per_game: '1.0',
        form: '2.0',
        dreamteam_count: 0,
        in_dreamteam: false,
        special: false,
        squad_number: 99,
        news: '',
        news_added: null,
        chance_of_playing_this_round: 100,
        chance_of_playing_next_round: 100,
        value_form: '2.0',
        value_season: '2.0',
        transfers_in: 1000,
        transfers_out: 1000,
        transfers_in_event: 100,
        transfers_out_event: 100,
        minutes: 90,
        goals_scored: 0,
        assists: 0,
        clean_sheets: 1,
        goals_conceded: 1,
        own_goals: 0,
        penalties_saved: 0,
        penalties_missed: 0,
        yellow_cards: 0,
        red_cards: 0,
        saves: 5,
        bonus: 0,
        bps: 20,
        influence: '10.0',
        creativity: '5.0',
        threat: '2.0',
        ict_index: '1.7',
        expected_goals: '0.1',
        expected_assists: '0.1',
        expected_goal_involvements: '0.2',
        expected_goals_conceded: '1.0',
        // Missing many optional fields - should still work
      } as any;

      const teamsMap = createTeamsMap(mockTeamsForPlayerStats);
      expect(() => transformPlayerStats([incompleteElement], 3, teamsMap)).not.toThrow();
      const result = transformPlayerStats([incompleteElement], 3, teamsMap);
      expect(result).toHaveLength(1);
      expect(result[0].elementId).toBe(999);
      expect(result[0].webName).toBe('Incomplete Player');
    });

    test('should handle edge case values correctly', () => {
      const edgeCaseElement = {
        id: 999,
        web_name: 'Edge Case Player',
        element_type: 1,
        team: 1,
        now_cost: 35, // Min price
        total_points: 0, // Edge case: zero points
        form: null as any, // Edge case: null form
        minutes: null, // Edge case: null minutes
        goals_scored: null,
        assists: null,
        // Add other required fields with null values
        code: 123456,
        cost_change_start: 0,
        cost_change_event: 0,
        cost_change_event_fall: 0,
        cost_change_start_fall: 0,
        first_name: 'Edge',
        second_name: 'Case',
        photo: 'jpg',
        status: 'a',
        selected_by_percent: '0.1',
        points_per_game: '0.0',
        dreamteam_count: 0,
        in_dreamteam: false,
        special: false,
        squad_number: null,
        news: '',
        news_added: null,
        chance_of_playing_this_round: null,
        chance_of_playing_next_round: null,
        value_form: '0.0',
        value_season: '0.0',
        transfers_in: 0,
        transfers_out: 0,
        transfers_in_event: 0,
        transfers_out_event: 0,
        clean_sheets: null,
        goals_conceded: null,
        own_goals: null,
        penalties_saved: null,
        penalties_missed: 0,
        yellow_cards: null,
        red_cards: null,
        saves: null,
        bonus: null,
        bps: null,
        influence: null,
        creativity: null,
        threat: null,
        ict_index: null,
        expected_goals: null,
        expected_assists: null,
        expected_goal_involvements: null,
        expected_goals_conceded: null,
      };

      const teamsMap = createTeamsMap(mockTeamsForPlayerStats);
      const result = transformPlayerStats([edgeCaseElement as any], 3, teamsMap);
      expect(result).toHaveLength(1);
      expect(result[0].elementId).toBe(999);
      expect(result[0].totalPoints).toBe(0); // Should handle 0 correctly
      expect(result[0].form).toBe(null); // Should handle null correctly
      expect(result[0].minutes).toBe(null); // Should handle null correctly
    });

    test('should validate player stat structure after transformation', () => {
      const teamsMap = createTeamsMap(mockTeamsForPlayerStats);
      const result = transformPlayerStats(rawFPLElementsFixture, 3, teamsMap);

      result.forEach((stat) => {
        // Required fields
        expect(typeof stat.eventId).toBe('number');
        expect(typeof stat.elementId).toBe('number');
        expect(typeof stat.webName).toBe('string');
        expect(typeof stat.elementType).toBe('number');
        expect(typeof stat.elementTypeName).toBe('string');
        expect(typeof stat.teamId).toBe('number');
        expect(typeof stat.teamName).toBe('string');
        expect(typeof stat.teamShortName).toBe('string');
        expect(typeof stat.value).toBe('number');

        // Nullable fields
        expect(['number', 'object']).toContain(typeof stat.totalPoints); // number or null
        expect(['string', 'object']).toContain(typeof stat.form); // string or null
        expect(['number', 'object']).toContain(typeof stat.minutes); // number or null

        // Value ranges
        expect(stat.eventId).toBeGreaterThan(0);
        expect(stat.elementId).toBeGreaterThan(0);
        expect(stat.webName.length).toBeGreaterThan(0);
        expect([1, 2, 3, 4]).toContain(stat.elementType);
        expect(['GKP', 'DEF', 'MID', 'FWD']).toContain(stat.elementTypeName);
        expect(stat.teamId).toBeGreaterThan(0);
        expect(stat.value).toBeGreaterThanOrEqual(35); // Min 3.5m
        expect(stat.value).toBeLessThanOrEqual(200); // Max 20.0m
      });
    });
  });

  describe('Performance Unit Tests', () => {
    test('should handle concurrent transformations', () => {
      const teamsMap = createTeamsMap(mockTeamsForPlayerStats);
      const datasets = Array(10).fill(rawFPLElementsFixture);

      const startTime = performance.now();
      const results = datasets.map((dataset) => transformPlayerStats(dataset, 3, teamsMap));
      const endTime = performance.now();

      expect(results.length).toBe(10);
      results.forEach((result) => {
        expect(result.length).toBe(4);
      });

      expect(endTime - startTime).toBeLessThan(100); // Should be very fast
    });

    test('should handle memory efficiently with large datasets', () => {
      const _teamsMap = createTeamsMap(mockTeamsForPlayerStats);
      const largeDataset = generatePlayerStats(1000);

      const startTime = performance.now();
      const filtered = filterPlayerStatsByPosition(largeDataset, 1);
      const endTime = performance.now();

      expect(filtered.length).toBeGreaterThan(0);
      expect(endTime - startTime).toBeLessThan(100); // Should be fast

      // Check filtering worked correctly
      filtered.forEach((stat) => {
        expect(stat.elementType).toBe(1);
        expect(stat.elementTypeName).toBe('GKP');
      });
    });
  });

  describe('Player Stats Specific Business Logic Tests', () => {
    test('should handle goalkeeper stats correctly', () => {
      expect(gkpPlayerStatFixture.elementType).toBe(1);
      expect(gkpPlayerStatFixture.elementTypeName).toBe('GKP');
      expect(gkpPlayerStatFixture.saves).toBeGreaterThan(0);
      expect(gkpPlayerStatFixture.cleanSheets).toBeGreaterThan(0);
      expect(gkpPlayerStatFixture.penaltiesSaved).toBeGreaterThanOrEqual(0);
    });

    test('should handle defender stats correctly', () => {
      expect(defPlayerStatFixture.elementType).toBe(2);
      expect(defPlayerStatFixture.elementTypeName).toBe('DEF');
      expect(defPlayerStatFixture.cleanSheets).toBeGreaterThan(0);
      expect(defPlayerStatFixture.goalsScored).toBeGreaterThanOrEqual(0);
    });

    test('should handle midfielder stats correctly', () => {
      expect(midPlayerStatFixture.elementType).toBe(3);
      expect(midPlayerStatFixture.elementTypeName).toBe('MID');
      expect(midPlayerStatFixture.goalsScored).toBeGreaterThan(0);
      expect(midPlayerStatFixture.assists).toBeGreaterThan(0);
    });

    test('should handle forward stats correctly', () => {
      expect(fwdPlayerStatFixture.elementType).toBe(4);
      expect(fwdPlayerStatFixture.elementTypeName).toBe('FWD');
      expect(fwdPlayerStatFixture.goalsScored).toBeGreaterThan(0);
      expect(fwdPlayerStatFixture.assists).toBeGreaterThanOrEqual(0);
    });

    test('should calculate position-specific value correctly', () => {
      // Premium midfielder should have good value
      const premiumMid = generatePlayerStat({
        elementType: 3,
        elementTypeName: 'MID',
        value: 120, // 12.0m
        totalPoints: 150, // 12.5 points per million
      });

      expect(getPointsPerMillion(premiumMid)).toBeCloseTo(12.5, 1);
      expect(hasGoodValue(premiumMid, 10)).toBe(true);
    });
  });
});
