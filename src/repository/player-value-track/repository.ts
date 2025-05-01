import { db } from 'db/index';
import { desc, eq } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainPlayerValueTrackToDbCreate,
  mapDbPlayerValueTrackToDomain,
} from 'repository/player-value-track/mapper';
import {
  PlayerValueTrackCreateInputs,
  PlayerValueTrackRepository,
} from 'repository/player-value-track/types';
import * as schema from 'schema/player-value-track.schema';
import { PlayerValueTracks } from 'types/domain/player-value-track.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createPlayerValueTrackRepository = (): PlayerValueTrackRepository => {
  const findByDate = (date: string): TE.TaskEither<DBError, PlayerValueTracks> =>
    pipe(
      TE.tryCatch(
        async () => {
          const playerValueTracks = await db
            .select()
            .from(schema.playerValueTracks)
            .where(eq(schema.playerValueTracks.date, date))
            .orderBy(desc(schema.playerValueTracks.date));
          return playerValueTracks.map(mapDbPlayerValueTrackToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to find player value tracks by date: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const savePlayerValueTracksByDate = (
    playerValueTrackInputs: PlayerValueTrackCreateInputs,
  ): TE.TaskEither<DBError, PlayerValueTracks> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = playerValueTrackInputs.map(mapDomainPlayerValueTrackToDbCreate);
          await db
            .insert(schema.playerValueTracks)
            .values(dataToCreate)
            .onConflictDoNothing({
              target: [
                schema.playerValueTracks.elementId,
                schema.playerValueTracks.date,
                schema.playerValueTracks.hourIndex,
              ],
            });
        },
        (error) => {
          console.error('Raw DB Error (savePlayerValueTracksByDate):', error);
          return createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to save player value tracks: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          });
        },
      ),
      TE.chain(() => {
        if (playerValueTrackInputs.length === 0) {
          return TE.right([]);
        }
        return findByDate(playerValueTrackInputs[0].date);
      }),
    );

  return {
    findByDate,
    savePlayerValueTracksByDate,
  };
};
