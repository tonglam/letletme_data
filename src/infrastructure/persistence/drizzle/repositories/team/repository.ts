import { db } from 'db/index';
import { asc, eq } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { mapDomainTeamToDbCreate, mapDbTeamToDomain } from 'repository/team/mapper';
import { TeamCreateInputs, TeamRepository } from 'repository/team/types';
import * as schema from 'schema/team.schema';
import { Team, TeamId, Teams } from 'types/domain/team.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createTeamRepository = (): TeamRepository => {
  const findById = (id: TeamId): TE.TaskEither<DBError, Team> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.teams)
            .where(eq(schema.teams.id, Number(id)));
          return mapDbTeamToDomain(result[0]);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch team by id ${id}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const findAll = (): TE.TaskEither<DBError, Teams> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db.select().from(schema.teams).orderBy(asc(schema.teams.id));
          return result.map(mapDbTeamToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all teams: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const saveBatch = (teamInputs: TeamCreateInputs): TE.TaskEither<DBError, Teams> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = teamInputs.map(mapDomainTeamToDbCreate);
          await db
            .insert(schema.teams)
            .values(dataToCreate)
            .onConflictDoNothing({
              target: [schema.teams.id],
            });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create teams in batch: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.chain(() => findAll()),
    );

  const deleteAll = (): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          await db.delete(schema.teams);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete all teams: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.map(() => undefined),
    );

  return {
    findById,
    findAll,
    saveBatch,
    deleteAll,
  };
};
