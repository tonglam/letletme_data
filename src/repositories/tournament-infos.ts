import { and, eq, gte, lte, sql } from 'drizzle-orm';

import { tournamentInfos, type DbTournamentInfo } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

export interface TournamentInfoSummary {
  id: number;
  leagueId: number;
  leagueType: 'classic' | 'h2h';
  totalTeamNum: number;
  groupMode: 'no_group' | 'points_races' | 'battle_races';
  groupStartedEventId: number | null;
  groupEndedEventId: number | null;
  groupQualifyNum: number | null;
  knockoutMode: 'no_knockout' | 'single_elimination' | 'double_elimination' | 'head_to_head';
  knockoutStartedEventId: number | null;
  knockoutEndedEventId: number | null;
  state: 'active' | 'inactive' | 'finished';
}

export interface TournamentInfoNameSummary {
  id: number;
  name: string;
  leagueId: number;
  leagueType: 'classic' | 'h2h';
}

function mapTournamentInfo(row: DbTournamentInfo): TournamentInfoSummary {
  return {
    id: row.id,
    leagueId: row.leagueId,
    leagueType: row.leagueType,
    totalTeamNum: row.totalTeamNum,
    groupMode: row.groupMode,
    groupStartedEventId: row.groupStartedEventId,
    groupEndedEventId: row.groupEndedEventId,
    groupQualifyNum: row.groupQualifyNum,
    knockoutMode: row.knockoutMode,
    knockoutStartedEventId: row.knockoutStartedEventId,
    knockoutEndedEventId: row.knockoutEndedEventId,
    state: row.state,
  };
}

export class TournamentInfoRepository {
  async findAllNames(): Promise<TournamentInfoNameSummary[]> {
    try {
      const db = await getDb();
      const rows = await db
        .select({
          id: tournamentInfos.id,
          name: tournamentInfos.name,
          leagueId: tournamentInfos.leagueId,
          leagueType: tournamentInfos.leagueType,
        })
        .from(tournamentInfos);
      logInfo('Retrieved tournament info names', { count: rows.length });
      return rows as TournamentInfoNameSummary[];
    } catch (error) {
      logError('Failed to retrieve tournament info names', error);
      throw new DatabaseError(
        'Failed to retrieve tournament info names',
        'TOURNAMENT_INFO_FIND_ALL_ERROR',
        error as Error,
      );
    }
  }

  async updateNames(updates: Array<{ id: number; name: string }>): Promise<number> {
    if (updates.length === 0) {
      return 0;
    }

    try {
      const db = await getDb();
      await db.transaction(async (tx) => {
        for (const update of updates) {
          await tx
            .update(tournamentInfos)
            .set({ name: update.name, updatedAt: new Date() })
            .where(eq(tournamentInfos.id, update.id));
        }
      });

      logInfo('Updated tournament info names', { count: updates.length });
      return updates.length;
    } catch (error) {
      logError('Failed to update tournament info names', error, { count: updates.length });
      throw new DatabaseError(
        'Failed to update tournament info names',
        'TOURNAMENT_INFO_UPDATE_ERROR',
        error as Error,
      );
    }
  }

  async findActive(): Promise<TournamentInfoSummary[]> {
    try {
      const db = await getDb();
      const rows = await db
        .select()
        .from(tournamentInfos)
        .where(eq(tournamentInfos.state, 'active'));
      const result = rows.map(mapTournamentInfo);
      logInfo('Retrieved active tournament infos', { count: result.length });
      return result;
    } catch (error) {
      logError('Failed to retrieve active tournament infos', error);
      throw new DatabaseError(
        'Failed to retrieve active tournament infos',
        'TOURNAMENT_INFO_FIND_ACTIVE_ERROR',
        error as Error,
      );
    }
  }

  async findPointsRaceByEvent(eventId: number): Promise<TournamentInfoSummary[]> {
    try {
      const db = await getDb();
      const rows = await db
        .select()
        .from(tournamentInfos)
        .where(
          and(
            eq(tournamentInfos.state, 'active'),
            eq(tournamentInfos.groupMode, 'points_races'),
            lte(tournamentInfos.groupStartedEventId, eventId),
            gte(tournamentInfos.groupEndedEventId, eventId),
          ),
        );
      const result = rows.map(mapTournamentInfo);
      logInfo('Retrieved points race tournaments', { eventId, count: result.length });
      return result;
    } catch (error) {
      logError('Failed to retrieve points race tournaments', error, { eventId });
      throw new DatabaseError(
        'Failed to retrieve points race tournaments',
        'TOURNAMENT_INFO_POINTS_RACE_ERROR',
        error as Error,
      );
    }
  }

  async findBattleRaceByEvent(eventId: number): Promise<TournamentInfoSummary[]> {
    try {
      const db = await getDb();
      const rows = await db
        .select()
        .from(tournamentInfos)
        .where(
          and(
            eq(tournamentInfos.state, 'active'),
            eq(tournamentInfos.groupMode, 'battle_races'),
            lte(tournamentInfos.groupStartedEventId, eventId),
            gte(tournamentInfos.groupEndedEventId, eventId),
          ),
        );
      const result = rows.map(mapTournamentInfo);
      logInfo('Retrieved battle race tournaments', { eventId, count: result.length });
      return result;
    } catch (error) {
      logError('Failed to retrieve battle race tournaments', error, { eventId });
      throw new DatabaseError(
        'Failed to retrieve battle race tournaments',
        'TOURNAMENT_INFO_BATTLE_RACE_ERROR',
        error as Error,
      );
    }
  }

  async findKnockoutByEvent(eventId: number): Promise<TournamentInfoSummary[]> {
    try {
      const db = await getDb();
      const rows = await db
        .select()
        .from(tournamentInfos)
        .where(
          and(
            eq(tournamentInfos.state, 'active'),
            sql`${tournamentInfos.knockoutMode} <> 'no_knockout'`,
            lte(tournamentInfos.knockoutStartedEventId, eventId),
            gte(tournamentInfos.knockoutEndedEventId, eventId),
          ),
        );
      const result = rows.map(mapTournamentInfo);
      logInfo('Retrieved knockout tournaments', { eventId, count: result.length });
      return result;
    } catch (error) {
      logError('Failed to retrieve knockout tournaments', error, { eventId });
      throw new DatabaseError(
        'Failed to retrieve knockout tournaments',
        'TOURNAMENT_INFO_KNOCKOUT_ERROR',
        error as Error,
      );
    }
  }
}

export const tournamentInfoRepository = new TournamentInfoRepository();
