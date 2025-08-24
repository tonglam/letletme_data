import { eq, sql } from 'drizzle-orm';

import { players, type NewPlayer, type Player } from '../db/schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Player as DomainPlayer } from '../types';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export class PlayerRepository {
  private db?: DatabaseInstance;

  constructor(dbInstance?: DatabaseInstance) {
    this.db = dbInstance;
  }

  private async getDbInstance() {
    return this.db || (await getDb());
  }

  async findAll(): Promise<Player[]> {
    try {
      const db = await this.getDbInstance();
      const result = await db.select().from(players).orderBy(players.id);
      logInfo('Retrieved all players', { count: result.length });
      return result;
    } catch (error) {
      logError('Failed to find all players', error);
      throw new DatabaseError(
        'Failed to retrieve players',
        'FIND_ALL_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findById(id: number): Promise<Player | null> {
    try {
      const db = await this.getDbInstance();
      const result = await db.select().from(players).where(eq(players.id, id));
      const player = result[0] || null;

      if (player) {
        logInfo('Retrieved player by id', { id });
      } else {
        logInfo('Player not found', { id });
      }

      return player;
    } catch (error) {
      logError('Failed to find player by id', error, { id });
      throw new DatabaseError(
        `Failed to retrieve player with id: ${id}`,
        'FIND_BY_ID_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findByTeam(teamId: number): Promise<Player[]> {
    try {
      const db = await this.getDbInstance();
      const result = await db.select().from(players).where(eq(players.teamId, teamId));
      logInfo('Retrieved players by team', { teamId, count: result.length });
      return result;
    } catch (error) {
      logError('Failed to find players by team', error, { teamId });
      throw new DatabaseError(
        `Failed to retrieve players for team: ${teamId}`,
        'FIND_BY_TEAM_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async upsert(player: DomainPlayer): Promise<Player> {
    try {
      const newPlayer: NewPlayer = {
        id: player.id,
        code: player.code,
        type: player.type,
        teamId: player.teamId,
        price: player.price,
        startPrice: player.startPrice,
        firstName: player.firstName,
        secondName: player.secondName,
        webName: player.webName,
        updatedAt: new Date(),
      };

      const db = await this.getDbInstance();
      const result = await db
        .insert(players)
        .values(newPlayer)
        .onConflictDoUpdate({
          target: players.id,
          set: {
            ...newPlayer,
            updatedAt: new Date(),
          },
        })
        .returning();

      const upsertedPlayer = result[0];
      logInfo('Upserted player', { id: upsertedPlayer.id });
      return upsertedPlayer;
    } catch (error) {
      logError('Failed to upsert player', error, { id: player.id });
      throw new DatabaseError(
        `Failed to upsert player with id: ${player.id}`,
        'UPSERT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async upsertBatch(domainPlayers: DomainPlayer[]): Promise<Player[]> {
    try {
      if (domainPlayers.length === 0) {
        return [];
      }

      const newPlayers: NewPlayer[] = domainPlayers.map((player) => ({
        id: player.id,
        code: player.code,
        type: player.type,
        teamId: player.teamId,
        price: player.price,
        startPrice: player.startPrice,
        firstName: player.firstName,
        secondName: player.secondName,
        webName: player.webName,
        updatedAt: new Date(),
      }));

      const db = await this.getDbInstance();
      const result = await db
        .insert(players)
        .values(newPlayers)
        .onConflictDoUpdate({
          target: players.id,
          set: {
            code: sql`excluded.code`,
            type: sql`excluded.type`,
            teamId: sql`excluded.team_id`,
            price: sql`excluded.price`,
            startPrice: sql`excluded.start_price`,
            firstName: sql`excluded.first_name`,
            secondName: sql`excluded.second_name`,
            webName: sql`excluded.web_name`,
            updatedAt: new Date(),
          },
        })
        .returning();

      logInfo('Batch upserted players', { count: result.length });
      return result;
    } catch (error) {
      logError('Failed to batch upsert players', error, { count: domainPlayers.length });
      throw new DatabaseError(
        'Failed to batch upsert players',
        'BATCH_UPSERT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async deleteAll(): Promise<void> {
    try {
      const db = await this.getDbInstance();
      await db.delete(players);
      logInfo('Deleted all players');
    } catch (error) {
      logError('Failed to delete all players', error);
      throw new DatabaseError(
        'Failed to delete all players',
        'DELETE_ALL_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }
}

// Export singleton instance
export const playerRepository = new PlayerRepository();
