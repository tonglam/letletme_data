import { inArray, sql } from 'drizzle-orm';

import { players, type DbPlayer, type DbPlayerInsert } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Player as DomainPlayer } from '../types';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

function mapDbPlayerToDomain(player: DbPlayer): DomainPlayer {
  return {
    id: player.id,
    code: player.code,
    type: player.type,
    teamId: player.teamId,
    price: player.price,
    startPrice: player.startPrice,
    firstName: player.firstName ?? player.webName,
    secondName: player.secondName ?? '',
    webName: player.webName,
  };
}

export const createPlayerRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    findByIds: async (ids: number[]): Promise<DomainPlayer[]> => {
      if (ids.length === 0) {
        return [];
      }

      try {
        const db = await getDbInstance();
        const uniqueIds = Array.from(new Set(ids));
        const chunks: number[][] = [];

        for (let index = 0; index < uniqueIds.length; index += 1000) {
          chunks.push(uniqueIds.slice(index, index + 1000));
        }

        const results: DbPlayer[] = [];
        for (const chunk of chunks) {
          const rows = await db.select().from(players).where(inArray(players.id, chunk));
          results.push(...rows);
        }

        const domainPlayers = results.map(mapDbPlayerToDomain);
        logInfo('Retrieved players by ids', { count: domainPlayers.length });
        return domainPlayers;
      } catch (error) {
        logError('Failed to retrieve players by ids', error);
        throw new DatabaseError('Failed to retrieve players', 'FIND_BY_IDS_ERROR', error as Error);
      }
    },

    upsertBatch: async (domainPlayers: DomainPlayer[]): Promise<DomainPlayer[]> => {
      try {
        if (domainPlayers.length === 0) {
          return [];
        }

        const newPlayers: DbPlayerInsert[] = domainPlayers.map((player) => ({
          id: player.id,
          code: player.code,
          type: player.type,
          teamId: player.teamId,
          price: player.price,
          startPrice: player.startPrice,
          firstName: player.firstName,
          secondName: player.secondName,
          webName: player.webName,
        }));

        const db = await getDbInstance();
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
              updatedAt: sql`NOW()`,
            },
          })
          .returning();

        const mappedPlayers = result.map(mapDbPlayerToDomain);
        logInfo('Batch upserted players', { count: mappedPlayers.length });
        return mappedPlayers;
      } catch (error) {
        logError('Failed to batch upsert players', error, { count: domainPlayers.length });
        throw new DatabaseError(
          'Failed to batch upsert players',
          'BATCH_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

// Export singleton instance
export const playerRepository = createPlayerRepository();
