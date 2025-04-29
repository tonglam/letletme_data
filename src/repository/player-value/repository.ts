import { db } from 'db/index';
import { eq, inArray, sql } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDbPlayerValueToDomain,
  mapDomainPlayerValueToPrismaCreate,
} from 'repository/player-value/mapper';
import { PlayerValueCreateInputs, PlayerValueRepository } from 'repository/player-value/types';
import * as schema from 'schema/player-value';
import { RawPlayerValues } from 'types/domain/player-value.type';
import { PlayerId } from 'types/domain/player.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createPlayerValueRepository = (): PlayerValueRepository => {
  const getLatestPlayerValuesByElements = (
    elementIds: ReadonlyArray<PlayerId>,
  ): TE.TaskEither<DBError, ReadonlyArray<{ elementId: PlayerId; value: number }>> =>
    pipe(
      TE.tryCatch(
        async () => {
          if (elementIds.length === 0) {
            return [];
          }

          const sq = db
            .select({
              elementId: schema.playerValues.elementId,
              value: schema.playerValues.value,
              rn: sql<number>`row_number() over (partition by ${schema.playerValues.elementId} order by ${schema.playerValues.changeDate} desc)`.as(
                'rn',
              ),
            })
            .from(schema.playerValues)
            .where(inArray(schema.playerValues.elementId, elementIds))
            .as('sq');

          const latestValues = await db
            .select({ elementId: sq.elementId, value: sq.value })
            .from(sq)
            .where(eq(sq.rn, 1));

          return latestValues.map((v) => ({ ...v, elementId: v.elementId as PlayerId }));
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to get latest player values by elements: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const findByChangeDate = (changeDate: string): TE.TaskEither<DBError, RawPlayerValues> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.playerValues)
            .where(eq(schema.playerValues.changeDate, changeDate));
          return result.map(mapDbPlayerValueToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player values by change date ${changeDate}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const findByElement = (elementId: PlayerId): TE.TaskEither<DBError, RawPlayerValues> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.playerValues)
            .where(eq(schema.playerValues.elementId, Number(elementId)));
          return result.map(mapDbPlayerValueToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player values by element ${elementId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const findByElements = (
    elementIds: ReadonlyArray<PlayerId>,
  ): TE.TaskEither<DBError, RawPlayerValues> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.playerValues)
            .where(inArray(schema.playerValues.elementId, elementIds));
          return result.map(mapDbPlayerValueToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player values by elements ${elementIds}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const savePlayerValueChangesByChangeDate = (
    playerValueInputs: PlayerValueCreateInputs,
  ): TE.TaskEither<DBError, RawPlayerValues> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = playerValueInputs.map(mapDomainPlayerValueToPrismaCreate);
          // Log the data just before insertion for debugging
          // console.log('Attempting to insert player values:', JSON.stringify(dataToCreate, null, 2));
          await db
            .insert(schema.playerValues)
            .values(dataToCreate)
            .onConflictDoNothing({
              target: [schema.playerValues.elementId, schema.playerValues.changeDate],
            });
          // console.log('Insertion attempt finished.');
        },
        (error) => {
          const errorMessage = getErrorMessage(error);
          // Log the full error object for more details
          console.error('DB Error (savePlayerValueChanges) - Raw Error:', error);
          console.error(
            'DB Error (savePlayerValueChanges) - Data Payload:',
            playerValueInputs.map(mapDomainPlayerValueToPrismaCreate),
          );
          return createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to save player value changes: ${errorMessage}`,
            cause: error instanceof Error ? error : undefined,
          });
        },
      ),
      TE.chain(() => findByChangeDate(playerValueInputs[0].changeDate)),
    );

  return {
    getLatestPlayerValuesByElements,
    findByChangeDate,
    findByElement,
    findByElements,
    savePlayerValueChangesByChangeDate,
  };
};
