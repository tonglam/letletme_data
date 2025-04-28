import { db } from 'db/index';
import { eq } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { mapDbTournamentInfoToDomain } from 'repository/tournament-info/mapper';
import { TournamentInfoRepository } from 'repository/tournament-info/types';
import * as schema from 'schema/tournament-info';
import { TournamentInfo, TournamentInfos } from 'types/domain/tournament-info.type';
import { TournamentId } from 'types/domain/tournament-info.type';
import { DBError, DBErrorCode } from 'types/error.type';
import { createDBError } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createTournamentInfoRepository = (): TournamentInfoRepository => {
  const findById = (id: TournamentId): TE.TaskEither<DBError, TournamentInfo> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.tournamentInfos)
            .where(eq(schema.tournamentInfos.id, Number(id)));
          return mapDbTournamentInfoToDomain(result[0]);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch tournament info by id ${id}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const findAll = (): TE.TaskEither<DBError, TournamentInfos> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db.select().from(schema.tournamentInfos);
          return result.map(mapDbTournamentInfoToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all tournament ids: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  return { findById, findAll };
};
