import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { mapPrismaEntryLeagueInfoToDomain } from 'src/repositories/entry-league-info/mapper';
import { EntryLeagueInfoRepository } from 'src/repositories/entry-league-info/types';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EntryLeagueInfo } from 'src/types/domain/entry-league-info.type';
import { LeagueId } from 'src/types/domain/league-info.type';
import { createDBError, DBError, DBErrorCode } from 'src/types/error.type';

export const createEntryLeagueInfoRepository = (
  prisma: PrismaClient,
): EntryLeagueInfoRepository => {
  const findByEntryId = (entryId: EntryId): TE.TaskEither<DBError, EntryLeagueInfo> =>
    pipe(
      TE.tryCatch(
        () => prisma.entryLeagueInfo.findUnique({ where: { id: Number(entryId) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch entry league info by id ${entryId}: ${error}`,
          }),
      ),
      TE.chainW((prismaEntryLeagueInfoOrNull) =>
        prismaEntryLeagueInfoOrNull
          ? TE.right(mapPrismaEntryLeagueInfoToDomain(prismaEntryLeagueInfoOrNull))
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Entry league info with ID ${entryId} not found in database`,
              }),
            ),
      ),
    );

  const upsertEntryLeagueInfo = (
    entryLeagueInfo: EntryLeagueInfo,
  ): TE.TaskEither<DBError, EntryLeagueInfo> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.entryLeagueInfo.upsert({
            where: {
              unique_entry_league_info: {
                entryId: Number(entryLeagueInfo.entryId),
                leagueId: Number(entryLeagueInfo.leagueId),
              },
            },
            update: entryLeagueInfo,
            create: entryLeagueInfo,
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to upsert entry league info: ${error}`,
          }),
      ),
      TE.map(mapPrismaEntryLeagueInfoToDomain),
    );

  const deleteEntryLeagueInfo = (
    entryId: EntryId,
    leagueId: LeagueId,
  ): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.entryLeagueInfo.delete({
            where: {
              unique_entry_league_info: {
                entryId: Number(entryId),
                leagueId: Number(leagueId),
              },
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete entry league info: ${error}`,
          }),
      ),
      TE.map(() => undefined),
    );

  return {
    findByEntryId,
    upsertEntryLeagueInfo,
    deleteEntryLeagueInfo,
  };
};
