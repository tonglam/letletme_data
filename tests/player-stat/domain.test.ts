import { Prisma } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { toDomainPlayerStat, toPrismaPlayerStat } from '../../src/domain/player-stat/types';
import type { ElementResponse } from '../../src/types/element.type';
import type { PlayerStat } from '../../src/types/player-stat.type';
import { validatePlayerStatId } from '../../src/types/player-stat.type';
import bootstrapData from '../data/bootstrap.json';

describe('Player Stat Domain Tests', () => {
  let testPlayerStats: PlayerStat[];

  beforeAll(() => {
    // Convert bootstrap players to domain player stats
    testPlayerStats = bootstrapData.elements.slice(0, 3).map((player) => {
      const id = `${player.id}_${new Date().toISOString().slice(0, 10)}`;
      const validatedId = pipe(
        validatePlayerStatId(id),
        E.getOrElseW(() => {
          throw new Error(`Invalid player stat ID: ${id}`);
        }),
      );
      return {
        ...toDomainPlayerStat(player as ElementResponse),
        id: validatedId,
        eventId: 1,
        elementId: player.id,
        teamId: player.team,
        form: player.form ? Number(player.form) : null,
        influence: player.influence ? Number(player.influence) : null,
        creativity: player.creativity ? Number(player.creativity) : null,
        threat: player.threat ? Number(player.threat) : null,
        ictIndex: player.ict_index ? Number(player.ict_index) : null,
        expectedGoals: player.expected_goals ? new Prisma.Decimal(player.expected_goals) : null,
        expectedAssists: player.expected_assists
          ? new Prisma.Decimal(player.expected_assists)
          : null,
        expectedGoalInvolvements: player.expected_goal_involvements
          ? new Prisma.Decimal(player.expected_goal_involvements)
          : null,
        expectedGoalsConceded: player.expected_goals_conceded
          ? new Prisma.Decimal(player.expected_goals_conceded)
          : null,
        minutes: player.minutes,
        goalsScored: player.goals_scored,
        assists: player.assists,
        cleanSheets: player.clean_sheets,
        goalsConceded: player.goals_conceded,
        ownGoals: player.own_goals,
        penaltiesSaved: player.penalties_saved,
        yellowCards: player.yellow_cards,
        redCards: player.red_cards,
        saves: player.saves,
        bonus: player.bonus,
        bps: player.bps,
        starts: player.starts,
        influenceRank: player.influence_rank,
        influenceRankType: player.influence_rank_type,
        creativityRank: player.creativity_rank,
        creativityRankType: player.creativity_rank_type,
        threatRank: player.threat_rank,
        threatRankType: player.threat_rank_type,
        ictIndexRank: player.ict_index_rank,
        ictIndexRankType: player.ict_index_rank_type,
        expectedGoalsPer90: null,
        savesPer90: null,
        expectedAssistsPer90: null,
        expectedGoalInvolvementsPer90: null,
      } as PlayerStat;
    });
  });

  describe('Domain Model Transformations', () => {
    it('should transform API response to domain model', () => {
      const apiResponse = bootstrapData.elements[0] as ElementResponse;
      const id = `${apiResponse.id}_${new Date().toISOString().slice(0, 10)}`;
      const validatedId = pipe(
        validatePlayerStatId(id),
        E.getOrElseW(() => {
          throw new Error(`Invalid player stat ID: ${id}`);
        }),
      );
      const playerStat = {
        ...toDomainPlayerStat(apiResponse),
        id: validatedId,
      } as PlayerStat;

      // Verify basic properties
      expect(playerStat.elementId).toBe(apiResponse.id);
      expect(playerStat.teamId).toBe(apiResponse.team);
      expect(playerStat.form).toBe(apiResponse.form ? Number(apiResponse.form) : null);
      expect(playerStat.influence).toBe(
        apiResponse.influence ? Number(apiResponse.influence) : null,
      );
      expect(playerStat.creativity).toBe(
        apiResponse.creativity ? Number(apiResponse.creativity) : null,
      );
      expect(playerStat.threat).toBe(apiResponse.threat ? Number(apiResponse.threat) : null);
      expect(playerStat.ictIndex).toBe(
        apiResponse.ict_index ? Number(apiResponse.ict_index) : null,
      );

      // Verify decimal properties
      if (apiResponse.expected_goals) {
        expect(
          new Prisma.Decimal(playerStat.expectedGoals?.toString() || '0').equals(
            new Prisma.Decimal(apiResponse.expected_goals),
          ),
        ).toBe(true);
      }
      if (apiResponse.expected_assists) {
        expect(
          new Prisma.Decimal(playerStat.expectedAssists?.toString() || '0').equals(
            new Prisma.Decimal(apiResponse.expected_assists),
          ),
        ).toBe(true);
      }
      if (apiResponse.expected_goal_involvements) {
        expect(
          new Prisma.Decimal(playerStat.expectedGoalInvolvements?.toString() || '0').equals(
            new Prisma.Decimal(apiResponse.expected_goal_involvements),
          ),
        ).toBe(true);
      }
      if (apiResponse.expected_goals_conceded) {
        expect(
          new Prisma.Decimal(playerStat.expectedGoalsConceded?.toString() || '0').equals(
            new Prisma.Decimal(apiResponse.expected_goals_conceded),
          ),
        ).toBe(true);
      }

      // Verify integer properties
      expect(playerStat.minutes).toBe(apiResponse.minutes);
      expect(playerStat.goalsScored).toBe(apiResponse.goals_scored);
      expect(playerStat.assists).toBe(apiResponse.assists);
      expect(playerStat.cleanSheets).toBe(apiResponse.clean_sheets);
      expect(playerStat.goalsConceded).toBe(apiResponse.goals_conceded);
      expect(playerStat.ownGoals).toBe(apiResponse.own_goals);
      expect(playerStat.penaltiesSaved).toBe(apiResponse.penalties_saved);
      expect(playerStat.yellowCards).toBe(apiResponse.yellow_cards);
      expect(playerStat.redCards).toBe(apiResponse.red_cards);
      expect(playerStat.saves).toBe(apiResponse.saves);
      expect(playerStat.bonus).toBe(apiResponse.bonus);
      expect(playerStat.bps).toBe(apiResponse.bps);
      expect(playerStat.starts).toBe(apiResponse.starts);

      // Verify rank properties
      expect(playerStat.influenceRank).toBe(apiResponse.influence_rank);
      expect(playerStat.influenceRankType).toBe(apiResponse.influence_rank_type);
      expect(playerStat.creativityRank).toBe(apiResponse.creativity_rank);
      expect(playerStat.creativityRankType).toBe(apiResponse.creativity_rank_type);
      expect(playerStat.threatRank).toBe(apiResponse.threat_rank);
      expect(playerStat.threatRankType).toBe(apiResponse.threat_rank_type);
      expect(playerStat.ictIndexRank).toBe(apiResponse.ict_index_rank);
      expect(playerStat.ictIndexRankType).toBe(apiResponse.ict_index_rank_type);
    });

    it('should transform domain model to Prisma model', () => {
      const playerStat = testPlayerStats[0];
      const prismaPlayerStat = toPrismaPlayerStat(playerStat);

      // Verify basic properties
      expect(prismaPlayerStat.eventId).toBe(playerStat.eventId);
      expect(prismaPlayerStat.elementId).toBe(playerStat.elementId);
      expect(prismaPlayerStat.teamId).toBe(playerStat.teamId);
      expect(prismaPlayerStat.form).toBe(playerStat.form);
      expect(prismaPlayerStat.influence).toBe(playerStat.influence);
      expect(prismaPlayerStat.creativity).toBe(playerStat.creativity);
      expect(prismaPlayerStat.threat).toBe(playerStat.threat);
      expect(prismaPlayerStat.ictIndex).toBe(playerStat.ictIndex);

      // Verify decimal properties with null checks
      if (playerStat.expectedGoals) {
        expect(prismaPlayerStat.expectedGoals?.toString()).toBe(
          playerStat.expectedGoals.toString(),
        );
      }
      if (playerStat.expectedAssists) {
        expect(prismaPlayerStat.expectedAssists?.toString()).toBe(
          playerStat.expectedAssists.toString(),
        );
      }
      if (playerStat.expectedGoalInvolvements) {
        expect(prismaPlayerStat.expectedGoalInvolvements?.toString()).toBe(
          playerStat.expectedGoalInvolvements.toString(),
        );
      }
      if (playerStat.expectedGoalsConceded) {
        expect(prismaPlayerStat.expectedGoalsConceded?.toString()).toBe(
          playerStat.expectedGoalsConceded.toString(),
        );
      }

      // Verify integer properties
      expect(prismaPlayerStat.minutes).toBe(playerStat.minutes);
      expect(prismaPlayerStat.goalsScored).toBe(playerStat.goalsScored);
      expect(prismaPlayerStat.assists).toBe(playerStat.assists);
      expect(prismaPlayerStat.cleanSheets).toBe(playerStat.cleanSheets);
      expect(prismaPlayerStat.goalsConceded).toBe(playerStat.goalsConceded);
      expect(prismaPlayerStat.ownGoals).toBe(playerStat.ownGoals);
      expect(prismaPlayerStat.penaltiesSaved).toBe(playerStat.penaltiesSaved);
      expect(prismaPlayerStat.yellowCards).toBe(playerStat.yellowCards);
      expect(prismaPlayerStat.redCards).toBe(playerStat.redCards);
      expect(prismaPlayerStat.saves).toBe(playerStat.saves);
      expect(prismaPlayerStat.bonus).toBe(playerStat.bonus);
      expect(prismaPlayerStat.bps).toBe(playerStat.bps);
      expect(prismaPlayerStat.starts).toBe(playerStat.starts);

      // Verify rank properties
      expect(prismaPlayerStat.influenceRank).toBe(playerStat.influenceRank);
      expect(prismaPlayerStat.influenceRankType).toBe(playerStat.influenceRankType);
      expect(prismaPlayerStat.creativityRank).toBe(playerStat.creativityRank);
      expect(prismaPlayerStat.creativityRankType).toBe(playerStat.creativityRankType);
      expect(prismaPlayerStat.threatRank).toBe(playerStat.threatRank);
      expect(prismaPlayerStat.threatRankType).toBe(playerStat.threatRankType);
      expect(prismaPlayerStat.ictIndexRank).toBe(playerStat.ictIndexRank);
      expect(prismaPlayerStat.ictIndexRankType).toBe(playerStat.ictIndexRankType);
    });

    it('should handle optional and null fields', () => {
      const apiResponse = {
        ...bootstrapData.elements[0],
        form: null,
        influence: null,
        creativity: null,
        threat: null,
        ict_index: null,
        expected_goals: null,
        expected_assists: null,
        expected_goal_involvements: null,
        expected_goals_conceded: null,
        influence_rank: null,
        influence_rank_type: null,
        creativity_rank: null,
        creativity_rank_type: null,
        threat_rank: null,
        threat_rank_type: null,
        ict_index_rank: null,
        ict_index_rank_type: null,
      } as ElementResponse;

      const id = `${apiResponse.id}_${new Date().toISOString().slice(0, 10)}`;
      const validatedId = pipe(
        validatePlayerStatId(id),
        E.getOrElseW(() => {
          throw new Error(`Invalid player stat ID: ${id}`);
        }),
      );
      const playerStat = {
        ...toDomainPlayerStat(apiResponse),
        id: validatedId,
      } as PlayerStat;

      // Verify null fields are handled correctly
      expect(playerStat.form).toBeNull();
      expect(playerStat.influence).toBeNull();
      expect(playerStat.creativity).toBeNull();
      expect(playerStat.threat).toBeNull();
      expect(playerStat.ictIndex).toBeNull();
      expect(playerStat.expectedGoals).toBeNull();
      expect(playerStat.expectedAssists).toBeNull();
      expect(playerStat.expectedGoalInvolvements).toBeNull();
      expect(playerStat.expectedGoalsConceded).toBeNull();
      expect(playerStat.influenceRank).toBeNull();
      expect(playerStat.influenceRankType).toBeNull();
      expect(playerStat.creativityRank).toBeNull();
      expect(playerStat.creativityRankType).toBeNull();
      expect(playerStat.threatRank).toBeNull();
      expect(playerStat.threatRankType).toBeNull();
      expect(playerStat.ictIndexRank).toBeNull();
      expect(playerStat.ictIndexRankType).toBeNull();
    });

    it('should enforce business logic constraints', () => {
      const playerStat = testPlayerStats[0];

      // Verify non-negative constraints
      expect(playerStat.minutes).toBeGreaterThanOrEqual(0);
      expect(playerStat.goalsScored).toBeGreaterThanOrEqual(0);
      expect(playerStat.assists).toBeGreaterThanOrEqual(0);
      expect(playerStat.cleanSheets).toBeGreaterThanOrEqual(0);
      expect(playerStat.goalsConceded).toBeGreaterThanOrEqual(0);
      expect(playerStat.ownGoals).toBeGreaterThanOrEqual(0);
      expect(playerStat.penaltiesSaved).toBeGreaterThanOrEqual(0);
      expect(playerStat.yellowCards).toBeGreaterThanOrEqual(0);
      expect(playerStat.redCards).toBeGreaterThanOrEqual(0);
      expect(playerStat.saves).toBeGreaterThanOrEqual(0);
      expect(playerStat.bonus).toBeGreaterThanOrEqual(0);
      expect(playerStat.bps).toBeGreaterThanOrEqual(0);
      expect(playerStat.starts).toBeGreaterThanOrEqual(0);

      // Verify ID format
      expect(playerStat.id).toMatch(/^\d+_\d{4}-\d{2}-\d{2}$/);
      expect(playerStat.elementId).toBeGreaterThan(0);
      expect(playerStat.teamId).toBeGreaterThan(0);
      expect(playerStat.eventId).toBeGreaterThan(0);
    });
  });
});
