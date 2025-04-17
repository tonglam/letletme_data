import { Prisma, PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { mapDomainPhaseToPrismaCreate, mapPrismaPhaseToDomain } from './mapper';
import { PrismaPhaseCreate } from './type';
import { PhaseRepository } from '../../domains/phase/types';
import { PhaseId } from '../../types/domain/phase.type';
import { createDBError, DBErrorCode } from '../../types/error.type';

export const createPhaseRepository = (prisma: PrismaClient): PhaseRepository => ({
  findAll: () =>
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
    ),

  findById: (id: PhaseId) =>
    pipe(
      TE.tryCatch(
        () => prisma.phase.findUnique({ where: { id: Number(id) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch phase by id ${id}: ${error}`,
          }),
      ),
      TE.map((prismaPhase) => (prismaPhase ? mapPrismaPhaseToDomain(prismaPhase) : null)),
    ),

  saveBatch: (phases: readonly PrismaPhaseCreate[]) =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = phases.map(mapDomainPhaseToPrismaCreate);
          await prisma.phase.createMany({
            data: dataToCreate as unknown as Prisma.PhaseCreateManyInput[],
            skipDuplicates: true,
          });

          const ids = phases.map((p) => Number(p.id));

          return prisma.phase.findMany({
            where: { id: { in: ids } },
            orderBy: { id: 'asc' },
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create phases in batch: ${error}`,
          }),
      ),
      TE.map((prismaPhases) => prismaPhases.map(mapPrismaPhaseToDomain)),
    ),

  deleteAll: () =>
    pipe(
      TE.tryCatch(
        () => prisma.phase.deleteMany({}),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete all phases: ${error}`,
          }),
      ),
      TE.map(() => void 0),
    ),
});
