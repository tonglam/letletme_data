import { eq, inArray, sql } from 'drizzle-orm';

import { playerValues, type PlayerValue as DbPlayerValue, type NewPlayerValue } from '../db/schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PlayerValue } from '../domain/player-values';
import type {
  ElementTypeId,
  ElementTypeName,
  EventId,
  PlayerId,
  PlayerTypeID,
  TeamId,
  ValueChangeType,
} from '../types/base.type';

// Type for the SQL query result that matches PlayerValue domain model
export type PlayerValueQueryResult = {
  elementId: PlayerId;
  webName: string;
  elementType: ElementTypeId;
  elementTypeName: ElementTypeName;
  eventId: EventId;
  teamId: TeamId;
  teamName: string;
  teamShortName: string;
  value: number;
  changeDate: string;
  changeType: ValueChangeType;
  lastValue: number;
};

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export class PlayerValuesRepository {
  private db?: DatabaseInstance;

  constructor(dbInstance?: DatabaseInstance) {
    this.db = dbInstance;
  }

  private async getDbInstance() {
    return this.db || (await getDb());
  }

  async findAll(): Promise<PlayerValueQueryResult[]> {
    try {
      const db = await this.getDbInstance();
      const result = await db.execute(sql`
        SELECT 
          element_id as "elementId",
          event_id as "eventId",
          web_name as "webName",
          element_type as "elementType",
          element_type_name as "elementTypeName",
          team_id as "teamId",
          team_name as "teamName",
          team_short_name as "teamShortName",
          value,
          last_value as "lastValue",
          change_date as "changeDate",
          change_type as "changeType"
        FROM player_values
        ORDER BY event_id, element_id
      `);
      logInfo('Retrieved all player values', { count: result.length });
      return result as unknown as PlayerValueQueryResult[];
    } catch (error) {
      logError('Failed to find all player values', error);
      throw new DatabaseError(
        'Failed to retrieve player values',
        'FIND_ALL_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findByEventId(eventId: EventId): Promise<PlayerValueQueryResult[]> {
    try {
      const db = await this.getDbInstance();
      const result = await db.execute(sql`
        SELECT 
          element_id as "elementId",
          event_id as "eventId",
          web_name as "webName",
          element_type as "elementType",
          element_type_name as "elementTypeName",
          team_id as "teamId",
          team_name as "teamName",
          team_short_name as "teamShortName",
          value,
          last_value as "lastValue",
          change_date as "changeDate",
          change_type as "changeType"
        FROM player_values
        WHERE event_id = ${eventId}
        ORDER BY element_id
      `);
      logInfo('Retrieved player values by event', { eventId, count: result.length });
      return result as unknown as PlayerValueQueryResult[];
    } catch (error) {
      logError('Failed to find player values by event', error, { eventId });
      throw new DatabaseError(
        `Failed to retrieve player values for event: ${eventId}`,
        'FIND_BY_EVENT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findByPlayerId(playerId: PlayerId): Promise<PlayerValueQueryResult[]> {
    try {
      const db = await this.getDbInstance();
      const result = await db.execute(sql`
        SELECT 
          element_id as "elementId",
          event_id as "eventId",
          web_name as "webName",
          element_type as "elementType",
          element_type_name as "elementTypeName",
          team_id as "teamId",
          team_name as "teamName",
          team_short_name as "teamShortName",
          value,
          last_value as "lastValue",
          change_date as "changeDate",
          change_type as "changeType"
        FROM player_values
        WHERE element_id = ${playerId}
        ORDER BY event_id
      `);
      logInfo('Retrieved player values by player', { playerId, count: result.length });
      return result as unknown as PlayerValueQueryResult[];
    } catch (error) {
      logError('Failed to find player values by player', error, { playerId });
      throw new DatabaseError(
        `Failed to retrieve player values for player: ${playerId}`,
        'FIND_BY_PLAYER_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findByTeamId(teamId: TeamId, eventId?: EventId): Promise<PlayerValueQueryResult[]> {
    try {
      const db = await this.getDbInstance();
      const result = eventId
        ? await db.execute(sql`
        SELECT 
          element_id as "elementId",
          event_id as "eventId",
          web_name as "webName",
          element_type as "elementType",
          element_type_name as "elementTypeName",
          team_id as "teamId",
          team_name as "teamName",
          team_short_name as "teamShortName",
          value,
          last_value as "lastValue",
          change_date as "changeDate",
          change_type as "changeType"
        FROM player_values
        WHERE team_id = ${teamId} AND event_id = ${eventId}
        ORDER BY event_id, element_id
        `)
        : await db.execute(sql`
        SELECT 
          element_id as "elementId",
          event_id as "eventId",
          web_name as "webName",
          element_type as "elementType",
          element_type_name as "elementTypeName",
          team_id as "teamId",
          team_name as "teamName",
          team_short_name as "teamShortName",
          value,
          last_value as "lastValue",
          change_date as "changeDate",
          change_type as "changeType"
        FROM player_values
        WHERE team_id = ${teamId}
        ORDER BY event_id, element_id
        `);

      logInfo('Retrieved player values by team', { teamId, eventId, count: result.length });
      return result as unknown as PlayerValueQueryResult[];
    } catch (error) {
      logError('Failed to find player values by team', error, { teamId, eventId });
      throw new DatabaseError(
        `Failed to retrieve player values for team: ${teamId}`,
        'FIND_BY_TEAM_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findByPosition(
    elementType: PlayerTypeID,
    eventId?: EventId,
  ): Promise<PlayerValueQueryResult[]> {
    try {
      const db = await this.getDbInstance();
      const result = eventId
        ? await db.execute(sql`
        SELECT 
          element_id as "elementId",
          event_id as "eventId",
          web_name as "webName",
          element_type as "elementType",
          element_type_name as "elementTypeName",
          team_id as "teamId",
          team_name as "teamName",
          team_short_name as "teamShortName",
          value,
          last_value as "lastValue",
          change_date as "changeDate",
          change_type as "changeType"
        FROM player_values
        WHERE element_type = ${elementType} AND event_id = ${eventId}
        ORDER BY event_id, element_id
        `)
        : await db.execute(sql`
        SELECT 
          element_id as "elementId",
          event_id as "eventId",
          web_name as "webName",
          element_type as "elementType",
          element_type_name as "elementTypeName",
          team_id as "teamId",
          team_name as "teamName",
          team_short_name as "teamShortName",
          value,
          last_value as "lastValue",
          change_date as "changeDate",
          change_type as "changeType"
        FROM player_values
        WHERE element_type = ${elementType}
        ORDER BY event_id, element_id
        `);

      logInfo('Retrieved player values by position', {
        elementType,
        eventId,
        count: result.length,
      });
      return result as unknown as PlayerValueQueryResult[];
    } catch (error) {
      logError('Failed to find player values by position', error, { elementType, eventId });
      throw new DatabaseError(
        `Failed to retrieve player values for position: ${elementType}`,
        'FIND_BY_POSITION_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findByChangeType(
    changeType: ValueChangeType,
    eventId?: EventId,
  ): Promise<PlayerValueQueryResult[]> {
    try {
      const db = await this.getDbInstance();
      const result = eventId
        ? await db.execute(sql`
        SELECT 
          element_id as "elementId",
          event_id as "eventId",
          web_name as "webName",
          element_type as "elementType",
          element_type_name as "elementTypeName",
          team_id as "teamId",
          team_name as "teamName",
          team_short_name as "teamShortName",
          value,
          last_value as "lastValue",
          change_date as "changeDate",
          change_type as "changeType"
        FROM player_values
        WHERE change_type = ${changeType} AND event_id = ${eventId}
        ORDER BY element_id
        `)
        : await db.execute(sql`
        SELECT 
          element_id as "elementId",
          event_id as "eventId",
          web_name as "webName",
          element_type as "elementType",
          element_type_name as "elementTypeName",
          team_id as "teamId",
          team_name as "teamName",
          team_short_name as "teamShortName",
          value,
          last_value as "lastValue",
          change_date as "changeDate",
          change_type as "changeType"
        FROM player_values
        WHERE change_type = ${changeType}
        ORDER BY event_id, element_id
        `);

      logInfo('Retrieved player values by change type', {
        changeType,
        eventId,
        count: result.length,
      });
      return result as unknown as PlayerValueQueryResult[];
    } catch (error) {
      logError('Failed to find player values by change type', error, { changeType, eventId });
      throw new DatabaseError(
        `Failed to retrieve player values for change type: ${changeType}`,
        'FIND_BY_CHANGE_TYPE_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findByEventAndPlayer(
    eventId: EventId,
    playerId: PlayerId,
  ): Promise<PlayerValueQueryResult | null> {
    try {
      const db = await this.getDbInstance();
      const result = await db.execute(sql`
        SELECT 
          element_id as "elementId",
          event_id as "eventId",
          web_name as "webName",
          element_type as "elementType",
          element_type_name as "elementTypeName",
          team_id as "teamId",
          team_name as "teamName",
          team_short_name as "teamShortName",
          value,
          last_value as "lastValue",
          change_date as "changeDate",
          change_type as "changeType"
        FROM player_values
        WHERE event_id = ${eventId} AND element_id = ${playerId}
        LIMIT 1
      `);

      logInfo('Retrieved player value by event and player', { eventId, playerId });
      return (result[0] as unknown as PlayerValueQueryResult) || null;
    } catch (error) {
      logError('Failed to find player value by event and player', error, { eventId, playerId });
      throw new DatabaseError(
        `Failed to retrieve player value for event: ${eventId}, player: ${playerId}`,
        'FIND_BY_EVENT_AND_PLAYER_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async upsert(playerValue: PlayerValue): Promise<DbPlayerValue> {
    try {
      const newPlayerValue: NewPlayerValue = {
        elementId: playerValue.elementId,
        eventId: playerValue.eventId,
        webName: playerValue.webName,
        elementType: playerValue.elementType,
        elementTypeName: playerValue.elementTypeName,
        teamId: playerValue.teamId,
        teamName: playerValue.teamName,
        teamShortName: playerValue.teamShortName,
        value: playerValue.value,
        lastValue: playerValue.lastValue,
        changeDate: playerValue.changeDate,
        changeType: playerValue.changeType,
      };

      const db = await this.getDbInstance();
      const result = await db
        .insert(playerValues)
        .values(newPlayerValue)
        .onConflictDoUpdate({
          target: [playerValues.eventId, playerValues.elementId],
          set: {
            webName: newPlayerValue.webName,
            elementTypeName: newPlayerValue.elementTypeName,
            teamId: newPlayerValue.teamId,
            teamName: newPlayerValue.teamName,
            teamShortName: newPlayerValue.teamShortName,
            value: newPlayerValue.value,
            lastValue: newPlayerValue.lastValue,
            changeDate: newPlayerValue.changeDate,
            changeType: newPlayerValue.changeType,
          },
        })
        .returning();

      const upsertedPlayerValue = result[0];
      logInfo('Upserted player value', {
        eventId: playerValue.eventId,
        playerId: playerValue.elementId,
      });
      return upsertedPlayerValue;
    } catch (error) {
      logError('Failed to upsert player value', error, {
        eventId: playerValue.eventId,
        playerId: playerValue.elementId,
      });
      throw new DatabaseError(
        `Failed to upsert player value for event: ${playerValue.eventId}, player: ${playerValue.elementId}`,
        'UPSERT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async upsertBatch(playerValuesData: PlayerValue[]): Promise<{ count: number }> {
    try {
      if (playerValuesData.length === 0) {
        return { count: 0 };
      }

      const newPlayerValues: NewPlayerValue[] = playerValuesData.map((playerValue) => ({
        elementId: playerValue.elementId,
        eventId: playerValue.eventId,
        webName: playerValue.webName,
        elementType: playerValue.elementType,
        elementTypeName: playerValue.elementTypeName,
        teamId: playerValue.teamId,
        teamName: playerValue.teamName,
        teamShortName: playerValue.teamShortName,
        value: playerValue.value,
        lastValue: playerValue.lastValue,
        changeDate: playerValue.changeDate,
        changeType: playerValue.changeType,
      }));

      const db = await this.getDbInstance();
      const result = await db
        .insert(playerValues)
        .values(newPlayerValues)
        .onConflictDoUpdate({
          target: [playerValues.eventId, playerValues.elementId],
          set: {
            webName: sql`excluded.web_name`,
            elementTypeName: sql`excluded.element_type_name`,
            teamId: sql`excluded.team_id`,
            teamName: sql`excluded.team_name`,
            teamShortName: sql`excluded.team_short_name`,
            value: sql`excluded.value`,
            lastValue: sql`excluded.last_value`,
            changeDate: sql`excluded.change_date`,
            changeType: sql`excluded.change_type`,
          },
        })
        .returning();

      logInfo('Batch upserted player values', { count: result.length });
      return { count: result.length };
    } catch (error) {
      logError('Failed to batch upsert player values', error, { count: playerValuesData.length });
      throw new DatabaseError(
        'Failed to batch upsert player values',
        'BATCH_UPSERT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async deleteByEventId(eventId: EventId): Promise<void> {
    try {
      const db = await this.getDbInstance();
      await db.delete(playerValues).where(eq(playerValues.eventId, eventId));
      logInfo('Deleted player values by event', { eventId });
    } catch (error) {
      logError('Failed to delete player values by event', error, { eventId });
      throw new DatabaseError(
        `Failed to delete player values for event: ${eventId}`,
        'DELETE_BY_EVENT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async deleteByPlayerIds(playerIds: PlayerId[]): Promise<void> {
    try {
      if (playerIds.length === 0) return;

      const db = await this.getDbInstance();
      await db.delete(playerValues).where(inArray(playerValues.elementId, playerIds));
      logInfo('Deleted player values by player IDs', { count: playerIds.length });
    } catch (error) {
      logError('Failed to delete player values by player IDs', error, { count: playerIds.length });
      throw new DatabaseError(
        'Failed to delete player values by player IDs',
        'DELETE_BY_PLAYER_IDS_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async getLatestEventId(): Promise<EventId | null> {
    try {
      const db = await this.getDbInstance();
      const result = await db
        .select({ eventId: playerValues.eventId })
        .from(playerValues)
        .orderBy(sql`${playerValues.eventId} DESC`)
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

  async getPlayerValuesCount(): Promise<number> {
    try {
      const db = await this.getDbInstance();
      const result = await db.select({ count: sql<number>`count(*)` }).from(playerValues);

      const count = Number(result[0]?.count) || 0;
      logInfo('Retrieved player values count', { count });
      return count;
    } catch (error) {
      logError('Failed to get player values count', error);
      throw new DatabaseError(
        'Failed to retrieve player values count',
        'GET_COUNT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  // Find latest stored value for each player (for change detection)
  async findLatestForAllPlayers(): Promise<DbPlayerValue[]> {
    try {
      const db = await this.getDbInstance();

      // Get the most recent record for each player
      const result = await db.execute(`
        SELECT DISTINCT ON (element_id) *
        FROM player_values 
        ORDER BY element_id, created_at DESC
      `);

      logInfo('Retrieved latest values for all players', { count: result.length });
      return result as unknown as DbPlayerValue[];
    } catch (error) {
      logError('Failed to find latest values for all players', error);
      throw new DatabaseError(
        'Failed to retrieve latest player values',
        'FIND_LATEST_ALL_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  // Find player values by change date (daily records)
  async findByChangeDate(changeDate: string): Promise<DbPlayerValue[]> {
    try {
      const db = await this.getDbInstance();

      const result = await db
        .select()
        .from(playerValues)
        .where(eq(playerValues.changeDate, changeDate));

      logInfo('Retrieved player values by change date', {
        changeDate,
        count: result.length,
      });
      return result;
    } catch (error) {
      logError('Failed to find player values by change date', error, { changeDate });
      throw new DatabaseError(
        `Failed to retrieve player values for date: ${changeDate}`,
        'FIND_BY_DATE_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  // Insert new records (not upsert, for daily change tracking)
  async insertBatch(playerValuesData: PlayerValue[]): Promise<{ count: number }> {
    try {
      if (playerValuesData.length === 0) {
        return { count: 0 };
      }

      const newPlayerValues = playerValuesData.map((playerValue) => ({
        elementId: playerValue.elementId,
        eventId: playerValue.eventId,
        webName: playerValue.webName,
        elementType: playerValue.elementType,
        elementTypeName: playerValue.elementTypeName,
        teamId: playerValue.teamId,
        teamName: playerValue.teamName,
        teamShortName: playerValue.teamShortName,
        value: playerValue.value,
        lastValue: playerValue.lastValue,
        changeDate: playerValue.changeDate,
        changeType: playerValue.changeType,
      }));

      const db = await this.getDbInstance();
      const result = await db.insert(playerValues).values(newPlayerValues).returning();

      logInfo('Batch inserted player values', { count: result.length });
      return { count: result.length };
    } catch (error) {
      logError('Failed to batch insert player values', error, { count: playerValuesData.length });
      throw new DatabaseError(
        'Failed to batch insert player values',
        'BATCH_INSERT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  // Delete all player values
  async deleteAll(): Promise<void> {
    try {
      const db = await this.getDbInstance();
      await db.execute('TRUNCATE TABLE player_values CASCADE');
      logInfo('Deleted all player values with CASCADE');
    } catch (error) {
      logError('Failed to delete all player values', error);
      throw new DatabaseError(
        'Failed to delete all player values',
        'DELETE_ALL_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }
}

// Export singleton instance
export const playerValuesRepository = new PlayerValuesRepository();
