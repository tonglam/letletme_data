import { db } from 'db/index';
import { eq } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainTournamentGroupToDbCreate,
  mapDbTournamentGroupToDomain,
} from 'repository/tournament-group/mapper';
import {
  TournamentGroupCreateInputs,
  TournamentGroupRepository,
} from 'repository/tournament-group/types';
import * as schema from 'schema/tournament-group.schema';
import { TournamentGroups } from 'types/domain/tournament-group.type';
import { TournamentId } from 'types/domain/tournament-info.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createTournamentGroupRepository = (): TournamentGroupRepository => {
  const findByTournamentId = (
    tournamentId: TournamentId,
  ): TE.TaskEither<DBError, TournamentGroups> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.tournamentGroups)
            .where(eq(schema.tournamentGroups.tournamentId, Number(tournamentId)));
          return result.map(mapDbTournamentGroupToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch tournament group by tournament id ${tournamentId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const saveBatchByTournamentId = (
    tournamentGroupInputs: TournamentGroupCreateInputs,
  ): TE.TaskEither<DBError, TournamentGroups> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = tournamentGroupInputs.map(mapDomainTournamentGroupToDbCreate);
          await db
            .insert(schema.tournamentGroups)
            .values(dataToCreate)
            .onConflictDoNothing({
              target: [schema.tournamentGroups.tournamentId, schema.tournamentGroups.groupId],
            });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create tournament groups in batch: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.chain(() => findByTournamentId(tournamentGroupInputs[0].tournamentId)),
    );

  return {
    findByTournamentId,
    saveBatchByTournamentId,
  };
};
