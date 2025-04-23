import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainPlayerValueTrackToPrismaCreate,
  mapPrismaPlayerValueTrackToDomain,
} from 'src/repositories/player-value-track/mapper';
import {
  PlayerValueTrackCreateInputs,
  PlayerValueTrackRepository,
} from 'src/repositories/player-value-track/type';
import { PlayerValueTracks } from 'src/types/domain/player-value-track.type';
import { createDBError, DBError, DBErrorCode } from 'src/types/error.type';
import { getErrorMessage } from 'src/utils/error.util';

export const createPlayerValueTrackRepository = (
  prisma: PrismaClient,
): PlayerValueTrackRepository => {
  const findByDate = (date: string): TE.TaskEither<DBError, PlayerValueTracks> =>
    pipe(
      TE.tryCatch(
        async () => {
          const playerValueTracks = await prisma.playerValueTrack.findMany({
            where: { date },
            orderBy: { date: 'desc' },
          });
          return playerValueTracks;
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to find player value tracks by date: ${getErrorMessage(error)}`,
          }),
      ),
      TE.map((prismaPlayerValueTracks) =>
        prismaPlayerValueTracks.map(mapPrismaPlayerValueTrackToDomain),
      ),
    );

  const savePlayerValueTracksByDate = (
    playerValueTrackInputs: PlayerValueTrackCreateInputs,
  ): TE.TaskEither<DBError, PlayerValueTracks> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = playerValueTrackInputs.map(mapDomainPlayerValueTrackToPrismaCreate);
          await prisma.playerValueTrack.createMany({
            data: dataToCreate,
            skipDuplicates: true,
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to save player value tracks: ${getErrorMessage(error)}`,
          }),
      ),
      TE.chain(() => findByDate(playerValueTrackInputs[0].date)),
    );

  const deleteByDate = (date: string): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          await prisma.playerValueTrack.deleteMany({
            where: { date },
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete player value tracks by date: ${getErrorMessage(error)}`,
          }),
      ),
    );

  return {
    findByDate,
    savePlayerValueTracksByDate,
    deleteByDate,
  };
};
