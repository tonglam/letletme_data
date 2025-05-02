import { db } from 'db/index';
import { asc, eq, sql } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { mapDomainStatToDbCreate, mapDbPlayerStatToDomain } from 'repository/player-stat/mapper';
import { PlayerStatCreateInputs, PlayerStatRepository } from 'repository/player-stat/types';
import * as schema from 'schema/player-stat.schema';
import { RawPlayerStats } from 'types/domain/player-stat.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createPlayerStatRepository = (): PlayerStatRepository => {
  const findLatest = (): TE.TaskEither<DBError, RawPlayerStats> =>
    pipe(
      TE.tryCatch(
        async () => {
          const maxEventResult = await db
            .select({
              _max: sql<number>`max(${schema.playerStats.eventId})`.as('_max'),
            })
            .from(schema.playerStats);
          const latestEvent = maxEventResult[0]._max;

          if (latestEvent === null) {
            return [];
          }

          const result = await db
            .select()
            .from(schema.playerStats)
            .where(eq(schema.playerStats.eventId, latestEvent))
            .orderBy(asc(schema.playerStats.elementId));
          return result.map(mapDbPlayerStatToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch latest player stats: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const saveLatest = (
    playerStatInputs: PlayerStatCreateInputs,
  ): TE.TaskEither<DBError, RawPlayerStats> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = playerStatInputs.map(mapDomainStatToDbCreate);
          await db
            .insert(schema.playerStats)
            .values(dataToCreate)
            .onConflictDoNothing({
              target: [schema.playerStats.eventId, schema.playerStats.elementId],
            });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.OPERATION_ERROR,
            message: `Failed saveBatch for PlayerStat: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.chain(() => findLatest()),
    );

  const deleteLatest = (): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const maxEventResult = await db
            .select({
              _max: sql<number>`max(${schema.playerStats.eventId})`.as('_max'),
            })
            .from(schema.playerStats);
          const latestEvent = maxEventResult[0]._max;

          if (latestEvent === null) {
            return;
          }
          await db.delete(schema.playerStats).where(eq(schema.playerStats.eventId, latestEvent));
        },
        (error) =>
          createDBError({
            code: DBErrorCode.OPERATION_ERROR,
            message: `Failed deleteLatest for PlayerStat: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  return {
    findLatest,
    saveLatest,
    deleteLatest,
  };
};
