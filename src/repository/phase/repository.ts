import { db } from 'db/index';
import { eq, asc } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { mapDomainPhaseToDbCreate, mapDbPhaseToDomain } from 'repository/phase/mapper';
import { PhaseCreateInputs, PhaseRepository } from 'repository/phase/types';
import * as schema from 'schema/phase';
import { Phase, PhaseId, Phases } from 'types/domain/phase.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createPhaseRepository = (): PhaseRepository => {
  const findById = (id: PhaseId): TE.TaskEither<DBError, Phase> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.phases)
            .where(eq(schema.phases.id, Number(id)))
            .limit(1);
          return mapDbPhaseToDomain(result[0]);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch phase by id ${id}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const findAll = (): TE.TaskEither<DBError, Phases> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db.select().from(schema.phases).orderBy(asc(schema.phases.id));
          return result.map(mapDbPhaseToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all phases: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const saveBatch = (phaseInputs: PhaseCreateInputs): TE.TaskEither<DBError, Phases> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = phaseInputs.map(mapDomainPhaseToDbCreate);
          await db
            .insert(schema.phases)
            .values(dataToCreate)
            .onConflictDoNothing({
              target: [schema.phases.id],
            });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create phases in batch: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.chain(() => findAll()),
    );

  const deleteAll = (): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          await db.delete(schema.phases);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete all phases: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  return {
    findById,
    findAll,
    saveBatch,
    deleteAll,
  };
};
