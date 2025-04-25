import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainPhaseToPrismaCreate,
  mapPrismaPhaseToDomain,
} from 'src/repositories/phase/mapper';
import { PhaseCreateInputs, PhaseRepository } from 'src/repositories/phase/types';
import { Phase, Phases } from 'src/types/domain/phase.type';

import { PhaseId } from '../../types/domain/phase.type';
import { createDBError, DBError, DBErrorCode } from '../../types/error.type';

export const createPhaseRepository = (prisma: PrismaClient): PhaseRepository => {
  const findById = (id: PhaseId): TE.TaskEither<DBError, Phase> =>
    pipe(
      TE.tryCatch(
        () => prisma.phase.findUnique({ where: { id: Number(id) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch phase by id ${id}: ${error}`,
          }),
      ),
      TE.chainW((prismaPhaseOrNull) =>
        prismaPhaseOrNull
          ? TE.right(mapPrismaPhaseToDomain(prismaPhaseOrNull))
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Phase with ID ${id} not found in database`,
              }),
            ),
      ),
    );

  const findAll = (): TE.TaskEither<DBError, Phases> =>
    pipe(
      TE.tryCatch(
        () => prisma.phase.findMany({ orderBy: { id: 'asc' } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all phases: ${error}`,
          }),
      ),
      TE.map((prismaPhases) => prismaPhases.map(mapPrismaPhaseToDomain)),
    );

  const saveBatch = (phaseInputs: PhaseCreateInputs): TE.TaskEither<DBError, Phases> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = phaseInputs.map(mapDomainPhaseToPrismaCreate);
          await prisma.phase.createMany({
            data: dataToCreate,
            skipDuplicates: true,
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create phases in batch: ${error}`,
          }),
      ),
      TE.chain(() => findAll()),
    );

  const deleteAll = (): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        () => prisma.phase.deleteMany({}),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete all phases: ${error}`,
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
