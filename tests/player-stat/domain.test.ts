import { Prisma } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import type { EventOperations } from '../../src/domain/event/types';
import { createPlayerStatOperations } from '../../src/domain/player-stat/operation';
import { toDomainPlayerStat, toPrismaPlayerStat } from '../../src/domain/player-stat/types';
import type { ElementResponse } from '../../src/types/element.type';
import {
  CacheErrorCode,
  createCacheError,
  createDBError,
  DBErrorCode,
  DomainErrorCode,
} from '../../src/types/error.type';
import type { Event } from '../../src/types/event.type';
import type {
  PlayerStat,
  PlayerStatRepository,
  PrismaPlayerStat,
} from '../../src/types/player-stat.type';
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

    it('should handle event-specific operations', () => {
      const playerStat = testPlayerStats[0];
      const testEventId = 1;

      // Verify event ID is properly set
      expect(playerStat.eventId).toBe(testEventId);

      // Verify event-specific fields are properly handled
      if (playerStat.expectedGoals) {
        expect(playerStat.expectedGoalsPer90).toBeDefined();
      }
      if (playerStat.expectedAssists) {
        expect(playerStat.expectedAssistsPer90).toBeDefined();
      }
      if (playerStat.expectedGoalInvolvements) {
        expect(playerStat.expectedGoalInvolvementsPer90).toBeDefined();
      }
      if (playerStat.saves) {
        expect(playerStat.savesPer90).toBeDefined();
      }
    });

    it('should handle element-specific operations', () => {
      const playerStat = testPlayerStats[0];

      // Verify element ID is properly set
      expect(playerStat.elementId).toBeGreaterThan(0);

      // Verify element-specific fields
      expect(playerStat.form).toBeDefined();
      expect(playerStat.influence).toBeDefined();
      expect(playerStat.creativity).toBeDefined();
      expect(playerStat.threat).toBeDefined();
      expect(playerStat.ictIndex).toBeDefined();
    });

    it('should handle team-specific operations', () => {
      const playerStat = testPlayerStats[0];

      // Verify team ID is properly set
      expect(playerStat.teamId).toBeGreaterThan(0);

      // Verify team-specific fields
      expect(playerStat.minutes).toBeDefined();
      expect(playerStat.starts).toBeDefined();
      expect(playerStat.cleanSheets).toBeDefined();
      expect(playerStat.goalsConceded).toBeDefined();
    });

    it('should validate ID format for different operations', () => {
      const playerStat = testPlayerStats[0];
      const idParts = playerStat.id.split('_');

      // Verify ID format for event operations
      expect(idParts).toHaveLength(2);
      expect(Number(idParts[0])).toBeGreaterThan(0); // element ID part
      expect(idParts[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/); // date part
    });
  });

  describe('Domain Operations', () => {
    const mockCache = {
      warmUp: jest.fn().mockReturnValue(TE.right(undefined)),
      cachePlayerStat: jest.fn().mockReturnValue(TE.right(undefined)),
      cachePlayerStats: jest.fn().mockReturnValue(TE.right(undefined)),
      getPlayerStat: jest.fn().mockReturnValue(TE.right(null)),
      getAllPlayerStats: jest.fn().mockReturnValue(TE.right([])),
    };

    const mockRepository: PlayerStatRepository = {
      findAll: jest.fn().mockReturnValue(TE.right([] as PrismaPlayerStat[])),
      findById: jest.fn().mockReturnValue(TE.right(null)),
      findByIds: jest.fn().mockReturnValue(TE.right([] as PrismaPlayerStat[])),
      findByEventId: jest.fn().mockReturnValue(TE.right([] as PrismaPlayerStat[])),
      findByElementId: jest.fn().mockReturnValue(TE.right([] as PrismaPlayerStat[])),
      findByTeamId: jest.fn().mockReturnValue(TE.right([] as PrismaPlayerStat[])),
      save: jest.fn().mockReturnValue(TE.right({} as PrismaPlayerStat)),
      saveBatch: jest.fn().mockReturnValue(TE.right([] as PrismaPlayerStat[])),
      update: jest.fn().mockReturnValue(TE.right({} as PrismaPlayerStat)),
      deleteAll: jest.fn().mockReturnValue(TE.right(undefined)),
      deleteByIds: jest.fn().mockReturnValue(TE.right(undefined)),
    };

    const mockEventOperations: EventOperations = {
      getCurrentEvent: jest.fn().mockReturnValue(TE.right({ id: 1 } as Event)),
      getAllEvents: jest.fn().mockReturnValue(TE.right([] as Event[])),
      getEventById: jest.fn().mockReturnValue(TE.right(null)),
      getNextEvent: jest.fn().mockReturnValue(TE.right(null)),
      createEvents: jest.fn().mockReturnValue(TE.right([] as Event[])),
      deleteAll: jest.fn().mockReturnValue(TE.right(undefined)),
    };

    const operations = createPlayerStatOperations(mockRepository, mockCache, mockEventOperations);

    beforeEach(() => {
      jest.clearAllMocks();
      (mockEventOperations.getCurrentEvent as jest.Mock).mockReturnValue(
        TE.right({ id: 1 } as Event),
      );
    });

    it('should use cache first when getting player stat by id', async () => {
      const testPlayerStat = testPlayerStats[0];
      (mockCache.getPlayerStat as jest.Mock).mockReturnValue(TE.right(testPlayerStat));

      const result = await operations.getPlayerStatById(testPlayerStat.id)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual(testPlayerStat);
      }
      expect(mockCache.getPlayerStat).toHaveBeenCalledWith(testPlayerStat.id.toString(), 1);
      expect(mockRepository.findById).not.toHaveBeenCalled();
    });

    it('should use cache first when getting player stats by team id', async () => {
      const teamId = 1;
      const teamStats = testPlayerStats.filter((stat) => stat.teamId === teamId);
      (mockCache.getAllPlayerStats as jest.Mock).mockReturnValue(TE.right(teamStats));

      const result = await operations.getPlayerStatByTeamId(teamId)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual(teamStats);
      }
      expect(mockCache.getAllPlayerStats).toHaveBeenCalledWith(1);
      expect(mockRepository.findByTeamId).not.toHaveBeenCalled();
    });

    it('should handle cache errors gracefully', async () => {
      const testPlayerStat = testPlayerStats[0];
      (mockCache.getPlayerStat as jest.Mock).mockReturnValue(
        TE.left(
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache error',
          }),
        ),
      );

      const result = await operations.getPlayerStatById(testPlayerStat.id)();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(DomainErrorCode.CACHE_ERROR);
      }
    });

    it('should handle missing current event', async () => {
      (mockEventOperations.getCurrentEvent as jest.Mock).mockReturnValue(TE.right(null));
      const testPlayerStat = testPlayerStats[0];

      const result = await operations.getPlayerStatById(testPlayerStat.id)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toBeNull();
      }
      expect(mockCache.getPlayerStat).not.toHaveBeenCalled();
    });

    it('should create player stats and update cache', async () => {
      const newStats = testPlayerStats;
      const prismaStats = newStats.map((stat) => ({
        ...toPrismaPlayerStat(stat),
        createdAt: new Date(),
      }));
      (mockRepository.saveBatch as jest.Mock).mockReturnValue(TE.right(prismaStats));
      (mockCache.cachePlayerStats as jest.Mock).mockReturnValue(TE.right(undefined));

      const result = await operations.createPlayerStats(newStats)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toHaveLength(newStats.length);
      }
      expect(mockRepository.saveBatch).toHaveBeenCalled();
      expect(mockCache.cachePlayerStats).toHaveBeenCalled();
    });

    it('should handle database errors during creation', async () => {
      const newStats = testPlayerStats;
      (mockRepository.saveBatch as jest.Mock).mockReturnValue(
        TE.left(
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: 'Database error',
          }),
        ),
      );

      const result = await operations.createPlayerStats(newStats)();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(DomainErrorCode.DATABASE_ERROR);
      }
      expect(mockCache.cachePlayerStats).not.toHaveBeenCalled();
    });

    it('should handle cache errors during creation', async () => {
      const newStats = testPlayerStats;
      const prismaStats = newStats.map((stat) => ({
        ...toPrismaPlayerStat(stat),
        createdAt: new Date(),
      }));
      (mockRepository.saveBatch as jest.Mock).mockReturnValue(TE.right(prismaStats));
      (mockCache.cachePlayerStats as jest.Mock).mockReturnValue(
        TE.left(
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache error',
          }),
        ),
      );

      const result = await operations.createPlayerStats(newStats)();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(DomainErrorCode.CACHE_ERROR);
      }
    });
  });
});
