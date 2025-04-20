import { PhaseOperations } from 'domains/phase/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { PhaseCreateInputs, PhaseRepository } from '../../repositories/phase/type';
import { Phases } from '../../types/domain/phase.type';
import { createDomainError, DomainError, DomainErrorCode } from '../../types/error.type';
import { getErrorMessage } from '../../utils/error.util';

export const createPhaseOperations = (repository: PhaseRepository): PhaseOperations => ({
  savePhases: (phases: PhaseCreateInputs): TE.TaskEither<DomainError, Phases> =>
    pipe(
      repository.saveBatch(phases),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveBatch): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    ),

  deleteAllPhases: () =>
    pipe(
      repository.deleteAll(),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (deleteAll): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    ),
});
