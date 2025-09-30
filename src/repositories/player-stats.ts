import { eq, inArray, sql } from 'drizzle-orm';

import {
  playerStats,
  type DbPlayerStat,
  type DbPlayerStatInsert,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PlayerStat } from '../domain/player-stats';
import type { ElementTypeId, EventId, PlayerId, TeamId } from '../types/base.type';

// Type for the SQL query result that matches PlayerStat domain model
type PlayerStatQueryResult = {
  eventId: number;
  elementId: number;
  webName: string;
  elementType: number;
  elementTypeName: string;
  teamId: number;
  teamName: string;
  teamShortName: string;
  value: number;
  totalPoints: number | null;
  form: number | null;
  influence: number | null;
  creativity: number | null;
  threat: number | null;
  ictIndex: number | null;
  expectedGoals: number | null;
  expectedAssists: number | null;
  expectedGoalInvolvements: number | null;
  expectedGoalsConceded: number | null;
  minutes: number | null;
  goalsScored: number | null;
  assists: number | null;
  cleanSheets: number | null;
  goalsConceded: number | null;
  ownGoals: number | null;
  penaltiesSaved: number | null;
  yellowCards: number | null;
  redCards: number | null;
  saves: number | null;
  bonus: number | null;
  bps: number | null;
  starts: number | null;
  influenceRank: number | null;
  influenceRankType: number | null;
  creativityRank: number | null;
  creativityRankType: number | null;
  threatRank: number | null;
  threatRankType: number | null;
  ictIndexRank: number | null;
  ictIndexRankType: number | null;
};

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export class PlayerStatsRepository {
  private db?: DatabaseInstance;

  constructor(dbInstance?: DatabaseInstance) {
    this.db = dbInstance;
  }

  private async getDbInstance() {
    return this.db || (await getDb());
  }

  async findAll(): Promise<PlayerStatQueryResult[]> {
    try {
      const db = await this.getDbInstance();
      const result = await db.execute(sql`
        SELECT 
          ps.id,
          ps.event_id as "eventId",
          ps.element_id as "elementId",
          ps.element_type as "elementType",
          ps.total_points as "totalPoints",
          ps.form,
          ps.influence,
          ps.creativity,
          ps.threat,
          ps.ict_index as "ictIndex",
          ps.expected_goals as "expectedGoals",
          ps.expected_assists as "expectedAssists",
          ps.expected_goal_involvements as "expectedGoalInvolvements",
          ps.expected_goals_conceded as "expectedGoalsConceded",
          ps.minutes,
          ps.goals_scored as "goalsScored",
          ps.assists,
          ps.clean_sheets as "cleanSheets",
          ps.goals_conceded as "goalsConceded",
          ps.own_goals as "ownGoals",
          ps.penalties_saved as "penaltiesSaved",
          ps.yellow_cards as "yellowCards",
          ps.red_cards as "redCards",
          ps.saves,
          ps.bonus,
          ps.bps,
          ps.starts,
          ps.influence_rank as "influenceRank",
          ps.influence_rank_type as "influenceRankType",
          ps.creativity_rank as "creativityRank",
          ps.creativity_rank_type as "creativityRankType",
          ps.threat_rank as "threatRank",
          ps.threat_rank_type as "threatRankType",
          ps.ict_index_rank as "ictIndexRank",
          ps.ict_index_rank_type as "ictIndexRankType",
          ps.created_at as "createdAt",
          ps.updated_at as "updatedAt",
          p.web_name as "webName",
          p.team_id as "teamId",
          p.price as "value",
          t.name as "teamName",
          t.short_name as "teamShortName",
          CASE 
            WHEN ps.element_type = 1 THEN 'GKP'
            WHEN ps.element_type = 2 THEN 'DEF'
            WHEN ps.element_type = 3 THEN 'MID'
            WHEN ps.element_type = 4 THEN 'FWD'
            ELSE 'UNK'
          END as "elementTypeName"
        FROM player_stats ps
        INNER JOIN players p ON ps.element_id = p.id
        INNER JOIN teams t ON p.team_id = t.id
        ORDER BY ps.event_id, ps.element_id
      `);
      logInfo('Retrieved all player stats', { count: result.length });
      return result as unknown as PlayerStatQueryResult[];
    } catch (error) {
      logError('Failed to find all player stats', error);
      throw new DatabaseError(
        'Failed to retrieve player stats',
        'FIND_ALL_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findByEventId(eventId: EventId): Promise<PlayerStatQueryResult[]> {
    try {
      const db = await this.getDbInstance();
      const result = await db.execute(sql`
        SELECT 
          ps.id,
          ps.event_id as "eventId",
          ps.element_id as "elementId",
          ps.element_type as "elementType",
          ps.total_points as "totalPoints",
          ps.form,
          ps.influence,
          ps.creativity,
          ps.threat,
          ps.ict_index as "ictIndex",
          ps.expected_goals as "expectedGoals",
          ps.expected_assists as "expectedAssists",
          ps.expected_goal_involvements as "expectedGoalInvolvements",
          ps.expected_goals_conceded as "expectedGoalsConceded",
          ps.minutes,
          ps.goals_scored as "goalsScored",
          ps.assists,
          ps.clean_sheets as "cleanSheets",
          ps.goals_conceded as "goalsConceded",
          ps.own_goals as "ownGoals",
          ps.penalties_saved as "penaltiesSaved",
          ps.yellow_cards as "yellowCards",
          ps.red_cards as "redCards",
          ps.saves,
          ps.bonus,
          ps.bps,
          ps.starts,
          ps.influence_rank as "influenceRank",
          ps.influence_rank_type as "influenceRankType",
          ps.creativity_rank as "creativityRank",
          ps.creativity_rank_type as "creativityRankType",
          ps.threat_rank as "threatRank",
          ps.threat_rank_type as "threatRankType",
          ps.ict_index_rank as "ictIndexRank",
          ps.ict_index_rank_type as "ictIndexRankType",
          ps.created_at as "createdAt",
          ps.updated_at as "updatedAt",
          p.web_name as "webName",
          p.team_id as "teamId",
          p.price as "value",
          t.name as "teamName",
          t.short_name as "teamShortName",
          CASE 
            WHEN ps.element_type = 1 THEN 'GKP'
            WHEN ps.element_type = 2 THEN 'DEF'
            WHEN ps.element_type = 3 THEN 'MID'
            WHEN ps.element_type = 4 THEN 'FWD'
            ELSE 'UNK'
          END as "elementTypeName"
        FROM player_stats ps
        INNER JOIN players p ON ps.element_id = p.id
        INNER JOIN teams t ON p.team_id = t.id
        WHERE ps.event_id = ${eventId}
        ORDER BY ps.element_id
      `);
      logInfo('Retrieved player stats by event', { eventId, count: result.length });
      return result as unknown as PlayerStatQueryResult[];
    } catch (error) {
      logError('Failed to find player stats by event', error, { eventId });
      throw new DatabaseError(
        `Failed to retrieve player stats for event: ${eventId}`,
        'FIND_BY_EVENT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findByPlayerId(playerId: PlayerId): Promise<PlayerStatQueryResult[]> {
    try {
      const db = await this.getDbInstance();
      const result = await db.execute(sql`
        SELECT 
          ps.id,
          ps.event_id as "eventId",
          ps.element_id as "elementId",
          ps.element_type as "elementType",
          ps.total_points as "totalPoints",
          ps.form,
          ps.influence,
          ps.creativity,
          ps.threat,
          ps.ict_index as "ictIndex",
          ps.expected_goals as "expectedGoals",
          ps.expected_assists as "expectedAssists",
          ps.expected_goal_involvements as "expectedGoalInvolvements",
          ps.expected_goals_conceded as "expectedGoalsConceded",
          ps.minutes,
          ps.goals_scored as "goalsScored",
          ps.assists,
          ps.clean_sheets as "cleanSheets",
          ps.goals_conceded as "goalsConceded",
          ps.own_goals as "ownGoals",
          ps.penalties_saved as "penaltiesSaved",
          ps.yellow_cards as "yellowCards",
          ps.red_cards as "redCards",
          ps.saves,
          ps.bonus,
          ps.bps,
          ps.starts,
          ps.influence_rank as "influenceRank",
          ps.influence_rank_type as "influenceRankType",
          ps.creativity_rank as "creativityRank",
          ps.creativity_rank_type as "creativityRankType",
          ps.threat_rank as "threatRank",
          ps.threat_rank_type as "threatRankType",
          ps.ict_index_rank as "ictIndexRank",
          ps.ict_index_rank_type as "ictIndexRankType",
          ps.created_at as "createdAt",
          ps.updated_at as "updatedAt",
          p.web_name as "webName",
          p.team_id as "teamId",
          p.price as "value",
          t.name as "teamName",
          t.short_name as "teamShortName",
          CASE 
            WHEN ps.element_type = 1 THEN 'GKP'
            WHEN ps.element_type = 2 THEN 'DEF'
            WHEN ps.element_type = 3 THEN 'MID'
            WHEN ps.element_type = 4 THEN 'FWD'
            ELSE 'UNK'
          END as "elementTypeName"
        FROM player_stats ps
        INNER JOIN players p ON ps.element_id = p.id
        INNER JOIN teams t ON p.team_id = t.id
        WHERE ps.element_id = ${playerId}
        ORDER BY ps.event_id
      `);
      logInfo('Retrieved player stats by player', { playerId, count: result.length });
      return result as unknown as PlayerStatQueryResult[];
    } catch (error) {
      logError('Failed to find player stats by player', error, { playerId });
      throw new DatabaseError(
        `Failed to retrieve player stats for player: ${playerId}`,
        'FIND_BY_PLAYER_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findByTeamId(teamId: TeamId, eventId?: EventId): Promise<PlayerStatQueryResult[]> {
    try {
      const db = await this.getDbInstance();
      const result = eventId
        ? await db.execute(sql`
        SELECT 
          ps.id,
          ps.event_id as "eventId",
          ps.element_id as "elementId",
          ps.element_type as "elementType",
          ps.total_points as "totalPoints",
          ps.form,
          ps.influence,
          ps.creativity,
          ps.threat,
          ps.ict_index as "ictIndex",
          ps.expected_goals as "expectedGoals",
          ps.expected_assists as "expectedAssists",
          ps.expected_goal_involvements as "expectedGoalInvolvements",
          ps.expected_goals_conceded as "expectedGoalsConceded",
          ps.minutes,
          ps.goals_scored as "goalsScored",
          ps.assists,
          ps.clean_sheets as "cleanSheets",
          ps.goals_conceded as "goalsConceded",
          ps.own_goals as "ownGoals",
          ps.penalties_saved as "penaltiesSaved",
          ps.yellow_cards as "yellowCards",
          ps.red_cards as "redCards",
          ps.saves,
          ps.bonus,
          ps.bps,
          ps.starts,
          ps.influence_rank as "influenceRank",
          ps.influence_rank_type as "influenceRankType",
          ps.creativity_rank as "creativityRank",
          ps.creativity_rank_type as "creativityRankType",
          ps.threat_rank as "threatRank",
          ps.threat_rank_type as "threatRankType",
          ps.ict_index_rank as "ictIndexRank",
          ps.ict_index_rank_type as "ictIndexRankType",
          ps.created_at as "createdAt",
          ps.updated_at as "updatedAt",
          p.web_name as "webName",
          p.team_id as "teamId",
          p.price as "value",
          t.name as "teamName",
          t.short_name as "teamShortName",
          CASE 
            WHEN ps.element_type = 1 THEN 'GKP'
            WHEN ps.element_type = 2 THEN 'DEF'
            WHEN ps.element_type = 3 THEN 'MID'
            WHEN ps.element_type = 4 THEN 'FWD'
            ELSE 'UNK'
          END as "elementTypeName"
        FROM player_stats ps
        INNER JOIN players p ON ps.element_id = p.id
        INNER JOIN teams t ON p.team_id = t.id
            WHERE p.team_id = ${teamId} AND ps.event_id = ${eventId}
            ORDER BY ps.event_id, ps.element_id
          `)
        : await db.execute(sql`
        SELECT 
          ps.id,
          ps.event_id as "eventId",
          ps.element_id as "elementId",
          ps.element_type as "elementType",
          ps.total_points as "totalPoints",
          ps.form,
          ps.influence,
          ps.creativity,
          ps.threat,
          ps.ict_index as "ictIndex",
          ps.expected_goals as "expectedGoals",
          ps.expected_assists as "expectedAssists",
          ps.expected_goal_involvements as "expectedGoalInvolvements",
          ps.expected_goals_conceded as "expectedGoalsConceded",
          ps.minutes,
          ps.goals_scored as "goalsScored",
          ps.assists,
          ps.clean_sheets as "cleanSheets",
          ps.goals_conceded as "goalsConceded",
          ps.own_goals as "ownGoals",
          ps.penalties_saved as "penaltiesSaved",
          ps.yellow_cards as "yellowCards",
          ps.red_cards as "redCards",
          ps.saves,
          ps.bonus,
          ps.bps,
          ps.starts,
          ps.influence_rank as "influenceRank",
          ps.influence_rank_type as "influenceRankType",
          ps.creativity_rank as "creativityRank",
          ps.creativity_rank_type as "creativityRankType",
          ps.threat_rank as "threatRank",
          ps.threat_rank_type as "threatRankType",
          ps.ict_index_rank as "ictIndexRank",
          ps.ict_index_rank_type as "ictIndexRankType",
          ps.created_at as "createdAt",
          ps.updated_at as "updatedAt",
          p.web_name as "webName",
          p.team_id as "teamId",
          p.price as "value",
          t.name as "teamName",
          t.short_name as "teamShortName",
          CASE 
            WHEN ps.element_type = 1 THEN 'GKP'
            WHEN ps.element_type = 2 THEN 'DEF'
            WHEN ps.element_type = 3 THEN 'MID'
            WHEN ps.element_type = 4 THEN 'FWD'
            ELSE 'UNK'
          END as "elementTypeName"
        FROM player_stats ps
        INNER JOIN players p ON ps.element_id = p.id
        INNER JOIN teams t ON p.team_id = t.id
            WHERE p.team_id = ${teamId}
            ORDER BY ps.event_id, ps.element_id
          `);

      logInfo('Retrieved player stats by team', { teamId, eventId, count: result.length });
      return result as unknown as PlayerStatQueryResult[];
    } catch (error) {
      logError('Failed to find player stats by team', error, { teamId, eventId });
      throw new DatabaseError(
        `Failed to retrieve player stats for team: ${teamId}`,
        'FIND_BY_TEAM_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findByPosition(
    elementType: ElementTypeId,
    eventId?: EventId,
  ): Promise<PlayerStatQueryResult[]> {
    try {
      const db = await this.getDbInstance();
      const result = eventId
        ? await db.execute(sql`
        SELECT 
          ps.id,
          ps.event_id as "eventId",
          ps.element_id as "elementId",
          ps.element_type as "elementType",
          ps.total_points as "totalPoints",
          ps.form,
          ps.influence,
          ps.creativity,
          ps.threat,
          ps.ict_index as "ictIndex",
          ps.expected_goals as "expectedGoals",
          ps.expected_assists as "expectedAssists",
          ps.expected_goal_involvements as "expectedGoalInvolvements",
          ps.expected_goals_conceded as "expectedGoalsConceded",
          ps.minutes,
          ps.goals_scored as "goalsScored",
          ps.assists,
          ps.clean_sheets as "cleanSheets",
          ps.goals_conceded as "goalsConceded",
          ps.own_goals as "ownGoals",
          ps.penalties_saved as "penaltiesSaved",
          ps.yellow_cards as "yellowCards",
          ps.red_cards as "redCards",
          ps.saves,
          ps.bonus,
          ps.bps,
          ps.starts,
          ps.influence_rank as "influenceRank",
          ps.influence_rank_type as "influenceRankType",
          ps.creativity_rank as "creativityRank",
          ps.creativity_rank_type as "creativityRankType",
          ps.threat_rank as "threatRank",
          ps.threat_rank_type as "threatRankType",
          ps.ict_index_rank as "ictIndexRank",
          ps.ict_index_rank_type as "ictIndexRankType",
          ps.created_at as "createdAt",
          ps.updated_at as "updatedAt",
          p.web_name as "webName",
          p.team_id as "teamId",
          p.price as "value",
          t.name as "teamName",
          t.short_name as "teamShortName",
          CASE 
            WHEN ps.element_type = 1 THEN 'GKP'
            WHEN ps.element_type = 2 THEN 'DEF'
            WHEN ps.element_type = 3 THEN 'MID'
            WHEN ps.element_type = 4 THEN 'FWD'
            ELSE 'UNK'
          END as "elementTypeName"
        FROM player_stats ps
        INNER JOIN players p ON ps.element_id = p.id
        INNER JOIN teams t ON p.team_id = t.id
            WHERE ps.element_type = ${elementType} AND ps.event_id = ${eventId}
            ORDER BY ps.event_id, ps.element_id
          `)
        : await db.execute(sql`
        SELECT 
          ps.id,
          ps.event_id as "eventId",
          ps.element_id as "elementId",
          ps.element_type as "elementType",
          ps.total_points as "totalPoints",
          ps.form,
          ps.influence,
          ps.creativity,
          ps.threat,
          ps.ict_index as "ictIndex",
          ps.expected_goals as "expectedGoals",
          ps.expected_assists as "expectedAssists",
          ps.expected_goal_involvements as "expectedGoalInvolvements",
          ps.expected_goals_conceded as "expectedGoalsConceded",
          ps.minutes,
          ps.goals_scored as "goalsScored",
          ps.assists,
          ps.clean_sheets as "cleanSheets",
          ps.goals_conceded as "goalsConceded",
          ps.own_goals as "ownGoals",
          ps.penalties_saved as "penaltiesSaved",
          ps.yellow_cards as "yellowCards",
          ps.red_cards as "redCards",
          ps.saves,
          ps.bonus,
          ps.bps,
          ps.starts,
          ps.influence_rank as "influenceRank",
          ps.influence_rank_type as "influenceRankType",
          ps.creativity_rank as "creativityRank",
          ps.creativity_rank_type as "creativityRankType",
          ps.threat_rank as "threatRank",
          ps.threat_rank_type as "threatRankType",
          ps.ict_index_rank as "ictIndexRank",
          ps.ict_index_rank_type as "ictIndexRankType",
          ps.created_at as "createdAt",
          ps.updated_at as "updatedAt",
          p.web_name as "webName",
          p.team_id as "teamId",
          p.price as "value",
          t.name as "teamName",
          t.short_name as "teamShortName",
          CASE 
            WHEN ps.element_type = 1 THEN 'GKP'
            WHEN ps.element_type = 2 THEN 'DEF'
            WHEN ps.element_type = 3 THEN 'MID'
            WHEN ps.element_type = 4 THEN 'FWD'
            ELSE 'UNK'
          END as "elementTypeName"
        FROM player_stats ps
        INNER JOIN players p ON ps.element_id = p.id
        INNER JOIN teams t ON p.team_id = t.id
            WHERE ps.element_type = ${elementType}
            ORDER BY ps.event_id, ps.element_id
          `);

      logInfo('Retrieved player stats by position', { elementType, eventId, count: result.length });
      return result as unknown as PlayerStatQueryResult[];
    } catch (error) {
      logError('Failed to find player stats by position', error, { elementType, eventId });
      throw new DatabaseError(
        `Failed to retrieve player stats for position: ${elementType}`,
        'FIND_BY_POSITION_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findByEventAndPlayer(
    eventId: EventId,
    playerId: PlayerId,
  ): Promise<PlayerStatQueryResult | null> {
    try {
      const db = await this.getDbInstance();
      const result = await db.execute(sql`
        SELECT 
          ps.id,
          ps.event_id as "eventId",
          ps.element_id as "elementId",
          ps.element_type as "elementType",
          ps.total_points as "totalPoints",
          ps.form,
          ps.influence,
          ps.creativity,
          ps.threat,
          ps.ict_index as "ictIndex",
          ps.expected_goals as "expectedGoals",
          ps.expected_assists as "expectedAssists",
          ps.expected_goal_involvements as "expectedGoalInvolvements",
          ps.expected_goals_conceded as "expectedGoalsConceded",
          ps.minutes,
          ps.goals_scored as "goalsScored",
          ps.assists,
          ps.clean_sheets as "cleanSheets",
          ps.goals_conceded as "goalsConceded",
          ps.own_goals as "ownGoals",
          ps.penalties_saved as "penaltiesSaved",
          ps.yellow_cards as "yellowCards",
          ps.red_cards as "redCards",
          ps.saves,
          ps.bonus,
          ps.bps,
          ps.starts,
          ps.influence_rank as "influenceRank",
          ps.influence_rank_type as "influenceRankType",
          ps.creativity_rank as "creativityRank",
          ps.creativity_rank_type as "creativityRankType",
          ps.threat_rank as "threatRank",
          ps.threat_rank_type as "threatRankType",
          ps.ict_index_rank as "ictIndexRank",
          ps.ict_index_rank_type as "ictIndexRankType",
          ps.created_at as "createdAt",
          ps.updated_at as "updatedAt",
          p.web_name as "webName",
          p.team_id as "teamId",
          p.price as "value",
          t.name as "teamName",
          t.short_name as "teamShortName",
          CASE 
            WHEN ps.element_type = 1 THEN 'GKP'
            WHEN ps.element_type = 2 THEN 'DEF'
            WHEN ps.element_type = 3 THEN 'MID'
            WHEN ps.element_type = 4 THEN 'FWD'
            ELSE 'UNK'
          END as "elementTypeName"
        FROM player_stats ps
        INNER JOIN players p ON ps.element_id = p.id
        INNER JOIN teams t ON p.team_id = t.id
        WHERE ps.event_id = ${eventId} AND ps.element_id = ${playerId}
        LIMIT 1
      `);

      logInfo('Retrieved player stat by event and player', { eventId, playerId });
      return (result[0] as unknown as PlayerStatQueryResult) || null;
    } catch (error) {
      logError('Failed to find player stat by event and player', error, { eventId, playerId });
      throw new DatabaseError(
        `Failed to retrieve player stat for event: ${eventId}, player: ${playerId}`,
        'FIND_BY_EVENT_AND_PLAYER_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async upsert(playerStat: PlayerStat): Promise<DbPlayerStat> {
    try {
      const newPlayerStat: DbPlayerStatInsert = {
        eventId: playerStat.eventId,
        elementId: playerStat.elementId,
        elementType: playerStat.elementType,
        totalPoints: playerStat.totalPoints,
        form: playerStat.form,
        influence: playerStat.influence,
        creativity: playerStat.creativity,
        threat: playerStat.threat,
        ictIndex: playerStat.ictIndex,
        expectedGoals: playerStat.expectedGoals,
        expectedAssists: playerStat.expectedAssists,
        expectedGoalInvolvements: playerStat.expectedGoalInvolvements,
        expectedGoalsConceded: playerStat.expectedGoalsConceded,
        minutes: playerStat.minutes,
        goalsScored: playerStat.goalsScored,
        assists: playerStat.assists,
        cleanSheets: playerStat.cleanSheets,
        goalsConceded: playerStat.goalsConceded,
        ownGoals: playerStat.ownGoals,
        penaltiesSaved: playerStat.penaltiesSaved,
        yellowCards: playerStat.yellowCards,
        redCards: playerStat.redCards,
        saves: playerStat.saves,
        bonus: playerStat.bonus,
        bps: playerStat.bps,
        starts: playerStat.starts,
        influenceRank: playerStat.influenceRank,
        influenceRankType: playerStat.influenceRankType,
        creativityRank: playerStat.creativityRank,
        creativityRankType: playerStat.creativityRankType,
        threatRank: playerStat.threatRank,
        threatRankType: playerStat.threatRankType,
        ictIndexRank: playerStat.ictIndexRank,
        ictIndexRankType: playerStat.ictIndexRankType,
        mngWin: playerStat.mngWin,
        mngDraw: playerStat.mngDraw,
        mngLoss: playerStat.mngLoss,
        mngUnderdogWin: playerStat.mngUnderdogWin,
        mngUnderdogDraw: playerStat.mngUnderdogDraw,
        mngCleanSheets: playerStat.mngCleanSheets,
        mngGoalsScored: playerStat.mngGoalsScored,
        updatedAt: new Date(),
      };

      const db = await this.getDbInstance();
      const result = await db
        .insert(playerStats)
        .values(newPlayerStat)
        .onConflictDoUpdate({
          target: [playerStats.eventId, playerStats.elementId],
          set: {
            ...newPlayerStat,
            updatedAt: new Date(),
          },
        })
        .returning();

      const upsertedPlayerStat = result[0];
      logInfo('Upserted player stat', {
        eventId: playerStat.eventId,
        playerId: playerStat.elementId,
      });
      return upsertedPlayerStat;
    } catch (error) {
      logError('Failed to upsert player stat', error, {
        eventId: playerStat.eventId,
        playerId: playerStat.elementId,
      });
      throw new DatabaseError(
        `Failed to upsert player stat for event: ${playerStat.eventId}, player: ${playerStat.elementId}`,
        'UPSERT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async upsertBatch(playerStatsList: PlayerStat[]): Promise<{ count: number }> {
    try {
      if (playerStatsList.length === 0) {
        return { count: 0 };
      }

      const newPlayerStats: DbPlayerStatInsert[] = playerStatsList.map((playerStat) => ({
        eventId: playerStat.eventId,
        elementId: playerStat.elementId,
        elementType: playerStat.elementType,
        totalPoints: playerStat.totalPoints,
        form: playerStat.form,
        influence: playerStat.influence,
        creativity: playerStat.creativity,
        threat: playerStat.threat,
        ictIndex: playerStat.ictIndex,
        expectedGoals: playerStat.expectedGoals,
        expectedAssists: playerStat.expectedAssists,
        expectedGoalInvolvements: playerStat.expectedGoalInvolvements,
        expectedGoalsConceded: playerStat.expectedGoalsConceded,
        minutes: playerStat.minutes,
        goalsScored: playerStat.goalsScored,
        assists: playerStat.assists,
        cleanSheets: playerStat.cleanSheets,
        goalsConceded: playerStat.goalsConceded,
        ownGoals: playerStat.ownGoals,
        penaltiesSaved: playerStat.penaltiesSaved,
        yellowCards: playerStat.yellowCards,
        redCards: playerStat.redCards,
        saves: playerStat.saves,
        bonus: playerStat.bonus,
        bps: playerStat.bps,
        starts: playerStat.starts,
        influenceRank: playerStat.influenceRank,
        influenceRankType: playerStat.influenceRankType,
        creativityRank: playerStat.creativityRank,
        creativityRankType: playerStat.creativityRankType,
        threatRank: playerStat.threatRank,
        threatRankType: playerStat.threatRankType,
        ictIndexRank: playerStat.ictIndexRank,
        ictIndexRankType: playerStat.ictIndexRankType,
        mngWin: playerStat.mngWin,
        mngDraw: playerStat.mngDraw,
        mngLoss: playerStat.mngLoss,
        mngUnderdogWin: playerStat.mngUnderdogWin,
        mngUnderdogDraw: playerStat.mngUnderdogDraw,
        mngCleanSheets: playerStat.mngCleanSheets,
        mngGoalsScored: playerStat.mngGoalsScored,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      const db = await this.getDbInstance();
      const result = await db
        .insert(playerStats)
        .values(newPlayerStats)
        .onConflictDoUpdate({
          target: [playerStats.eventId, playerStats.elementId],
          set: {
            totalPoints: sql`excluded.total_points`,
            form: sql`excluded.form`,
            influence: sql`excluded.influence`,
            creativity: sql`excluded.creativity`,
            threat: sql`excluded.threat`,
            ictIndex: sql`excluded.ict_index`,
            expectedGoals: sql`excluded.expected_goals`,
            expectedAssists: sql`excluded.expected_assists`,
            expectedGoalInvolvements: sql`excluded.expected_goal_involvements`,
            expectedGoalsConceded: sql`excluded.expected_goals_conceded`,
            minutes: sql`excluded.minutes`,
            goalsScored: sql`excluded.goals_scored`,
            assists: sql`excluded.assists`,
            cleanSheets: sql`excluded.clean_sheets`,
            goalsConceded: sql`excluded.goals_conceded`,
            ownGoals: sql`excluded.own_goals`,
            penaltiesSaved: sql`excluded.penalties_saved`,
            yellowCards: sql`excluded.yellow_cards`,
            redCards: sql`excluded.red_cards`,
            saves: sql`excluded.saves`,
            bonus: sql`excluded.bonus`,
            bps: sql`excluded.bps`,
            starts: sql`excluded.starts`,
            influenceRank: sql`excluded.influence_rank`,
            influenceRankType: sql`excluded.influence_rank_type`,
            creativityRank: sql`excluded.creativity_rank`,
            creativityRankType: sql`excluded.creativity_rank_type`,
            threatRank: sql`excluded.threat_rank`,
            threatRankType: sql`excluded.threat_rank_type`,
            ictIndexRank: sql`excluded.ict_index_rank`,
            ictIndexRankType: sql`excluded.ict_index_rank_type`,
            updatedAt: sql`NOW()`,
          },
        })
        .returning();

      logInfo('Batch upserted player stats', { count: result.length });
      return { count: result.length };
    } catch (error) {
      logError('Failed to batch upsert player stats', error, { count: playerStatsList.length });
      throw new DatabaseError(
        'Failed to batch upsert player stats',
        'BATCH_UPSERT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async deleteByEventId(eventId: EventId): Promise<void> {
    try {
      const db = await this.getDbInstance();
      await db.delete(playerStats).where(eq(playerStats.eventId, eventId));
      logInfo('Deleted player stats by event', { eventId });
    } catch (error) {
      logError('Failed to delete player stats by event', error, { eventId });
      throw new DatabaseError(
        `Failed to delete player stats for event: ${eventId}`,
        'DELETE_BY_EVENT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async deleteByPlayerIds(playerIds: PlayerId[]): Promise<void> {
    try {
      if (playerIds.length === 0) return;

      const db = await this.getDbInstance();
      await db.delete(playerStats).where(inArray(playerStats.elementId, playerIds));
      logInfo('Deleted player stats by player IDs', { count: playerIds.length });
    } catch (error) {
      logError('Failed to delete player stats by player IDs', error, { count: playerIds.length });
      throw new DatabaseError(
        'Failed to delete player stats by player IDs',
        'DELETE_BY_PLAYER_IDS_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async getLatestEventId(): Promise<EventId | null> {
    try {
      const db = await this.getDbInstance();
      const result = await db
        .select({ eventId: playerStats.eventId })
        .from(playerStats)
        .orderBy(sql`${playerStats.eventId} DESC`)
        .limit(1);

      const latestEventId = result[0]?.eventId || null;
      logInfo('Retrieved latest event id', { latestEventId });
      return latestEventId;
    } catch (error) {
      logError('Failed to retrieve latest event id', error);
      throw new DatabaseError(
        'Failed to retrieve latest event id',
        'GET_LATEST_EVENT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async getPlayerStatsCount(): Promise<number> {
    try {
      const db = await this.getDbInstance();
      const result = await db.select({ count: sql<number>`count(*)` }).from(playerStats);

      const count = Number(result[0]?.count) || 0;
      logInfo('Retrieved player stats count', { count });
      return count;
    } catch (error) {
      logError('Failed to get player stats count', error);
      throw new DatabaseError(
        'Failed to retrieve player stats count',
        'GET_COUNT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }
}

// Export singleton instance
export const playerStatsRepository = new PlayerStatsRepository();
