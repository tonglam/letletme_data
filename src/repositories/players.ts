import { and, eq, inArray, sql } from 'drizzle-orm';

import { playersInFpl, type DbPlayer, type DbPlayerInsert } from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { Player as DomainPlayer } from '../types';

function mapDbPlayerToDomain(player: DbPlayer): DomainPlayer {
  return {
    id: player.elementId,
    code: player.code,
    type: player.elementType,
    teamId: player.teamId,
    price: player.price,
    startPrice: player.startPrice,
    firstName: player.firstName ?? player.webName,
    secondName: player.secondName ?? '',
    webName: player.webName,
  };
}

export const createPlayerRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    findAll: async (
      season: FplSeasonRef,
      options: { lock?: boolean } = {},
    ): Promise<DomainPlayer[]> => {
      try {
        const db = await getDbInstance();
        const query = db
          .select()
          .from(playersInFpl)
          .where(eq(playersInFpl.seasonId, season.seasonId));
        const rows = options.lock ? await query.for('update') : await query;
        return rows.map(mapDbPlayerToDomain);
      } catch (error) {
        logError('Failed to retrieve all playersInFpl', error);
        throw new DatabaseError(
          'Failed to retrieve playersInFpl',
          'FIND_ALL_PLAYERS_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findByIds: async (season: FplSeasonRef, ids: number[]): Promise<DomainPlayer[]> => {
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
          const rows = await db
            .select()
            .from(playersInFpl)
            .where(
              and(
                eq(playersInFpl.seasonId, season.seasonId),
                inArray(playersInFpl.elementId, chunk),
              ),
            );
          results.push(...rows);
        }

        const domainPlayers = results.map(mapDbPlayerToDomain);
        logInfo('Retrieved playersInFpl by ids', { count: domainPlayers.length });
        return domainPlayers;
      } catch (error) {
        logError('Failed to retrieve playersInFpl by ids', error);
        throw new DatabaseError(
          'Failed to retrieve playersInFpl',
          'FIND_BY_IDS_ERROR',
          error as Error,
        );
      }
    },

    updatePrices: async (
      season: FplSeasonRef,
      priceUpdates: Array<{ elementId: number; value: number }>,
      sourceCheckedAt: Date,
    ): Promise<DomainPlayer[]> => {
      if (priceUpdates.length === 0) {
        return [];
      }

      try {
        const deduplicated = Array.from(
          new Map(priceUpdates.map((update) => [update.elementId, update])).values(),
        );
        const elementIds = deduplicated.map((update) => update.elementId);
        const priceCases = deduplicated.map(
          (update) => sql`WHEN ${update.elementId} THEN ${update.value}`,
        );
        const priceExpression = sql`CASE ${playersInFpl.elementId} ${sql.join(
          priceCases,
          sql.raw(' '),
        )} ELSE ${playersInFpl.price} END`;

        const db = await getDbInstance();
        const sourceCheckedAtIso = sourceCheckedAt.toISOString();
        const updated = await db
          .update(playersInFpl)
          .set({
            price: priceExpression,
            priceSourceCheckedAt: sourceCheckedAt,
            updatedAt: sql`NOW()`,
          })
          .where(
            and(
              inArray(playersInFpl.elementId, elementIds),
              eq(playersInFpl.seasonId, season.seasonId),
              sql`(
                ${playersInFpl.priceSourceCheckedAt} IS NULL OR
                ${playersInFpl.priceSourceCheckedAt} <= ${sourceCheckedAtIso}::timestamptz
              )`,
            ),
          )
          .returning();

        const mappedPlayers = updated.map(mapDbPlayerToDomain);
        logInfo('Batch updated player prices', { count: mappedPlayers.length });
        return mappedPlayers;
      } catch (error) {
        logError('Failed to batch update player prices', error, { count: priceUpdates.length });
        throw new DatabaseError(
          'Failed to batch update player prices',
          'BATCH_PRICE_UPDATE_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    upsertBatch: async (
      season: FplSeasonRef,
      domainPlayers: DomainPlayer[],
      preservePriceSourceCheckedAtOrAfter?: Date,
    ): Promise<DomainPlayer[]> => {
      try {
        if (domainPlayers.length === 0) {
          return [];
        }

        const sourceCheckedAtIso = preservePriceSourceCheckedAtOrAfter?.toISOString();
        const newPlayers: DbPlayerInsert[] = domainPlayers.map((player) => ({
          seasonId: season.seasonId,
          elementId: player.id,
          code: player.code,
          elementType: player.type,
          teamId: player.teamId,
          price: player.price,
          ...(sourceCheckedAtIso
            ? { priceSourceCheckedAt: preservePriceSourceCheckedAtOrAfter }
            : {}),
          startPrice: player.startPrice,
          firstName: player.firstName,
          secondName: player.secondName,
          webName: player.webName,
        }));

        const db = await getDbInstance();
        const result = await db
          .insert(playersInFpl)
          .values(newPlayers)
          .onConflictDoUpdate({
            target: [playersInFpl.seasonId, playersInFpl.elementId],
            set: {
              code: sql`excluded.code`,
              elementType: sql`excluded.element_type`,
              teamId: sql`excluded.team_id`,
              price: sql`excluded.price`,
              priceSourceCheckedAt: sourceCheckedAtIso
                ? sql`CASE
                    WHEN ${playersInFpl.priceSourceCheckedAt} >= ${sourceCheckedAtIso}::timestamptz
                    THEN ${playersInFpl.priceSourceCheckedAt}
                    ELSE ${sourceCheckedAtIso}::timestamptz
                  END`
                : sql`${playersInFpl.priceSourceCheckedAt}`,
              startPrice: sql`excluded.start_price`,
              firstName: sql`excluded.first_name`,
              secondName: sql`excluded.second_name`,
              webName: sql`excluded.web_name`,
              updatedAt: sql`NOW()`,
            },
          })
          .returning();

        const mappedPlayers = result.map(mapDbPlayerToDomain);
        logInfo('Batch upserted playersInFpl', { count: mappedPlayers.length });
        return mappedPlayers;
      } catch (error) {
        logError('Failed to batch upsert playersInFpl', error, { count: domainPlayers.length });
        throw new DatabaseError(
          'Failed to batch upsert playersInFpl',
          'BATCH_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

// Export singleton instance
export const playerRepository = createPlayerRepository();
