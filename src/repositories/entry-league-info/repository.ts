import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { mapPrismaEntryLeagueInfoToDomain } from 'src/repositories/entry-league-info/mapper';
import { EntryLeagueInfoRepository } from 'src/repositories/entry-league-info/types';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EntryLeagueInfo, EntryLeagueInfos } from 'src/types/domain/entry-league-info.type';
import { createDBError, DBError, DBErrorCode } from 'src/types/error.type';

export const createEntryLeagueInfoRepository = (
  prisma: PrismaClient,
): EntryLeagueInfoRepository => {
  const findByEntryId = (entryId: EntryId): TE.TaskEither<DBError, EntryLeagueInfos> =>
    pipe(
      TE.tryCatch(
        () => prisma.entryLeagueInfo.findMany({ where: { entryId: Number(entryId) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch entry league info by id ${entryId}: ${error}`,
          }),
      ),
      TE.map((prismaInfos) => prismaInfos.map(mapPrismaEntryLeagueInfoToDomain)),
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

  const deleteByEntryId = (entryId: EntryId): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        () => prisma.entryLeagueInfo.deleteMany({ where: { entryId: Number(entryId) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete entry league info by id ${entryId}: ${error}`,
          }),
      ),
      TE.map(() => undefined),
    );

  return {
    findByEntryId,
    upsertEntryLeagueInfo,
    deleteByEntryId,
  };
};
