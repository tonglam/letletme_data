import { PhaseOperations } from 'domain/phase/types';

import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PhaseCreateInputs, PhaseRepository } from 'repository/phase/types';
import { Phases } from 'types/domain/phase.type';
import { createDomainError, DomainError, DomainErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createPhaseOperations = (repository: PhaseRepository): PhaseOperations => {
  const savePhases = (phaseInputs: PhaseCreateInputs): TE.TaskEither<DomainError, Phases> =>
    pipe(
      repository.saveBatch(phaseInputs),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveBatch): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  const deleteAllPhases = (): TE.TaskEither<DomainError, void> =>
    pipe(
      repository.deleteAll(),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (deleteAll): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  return {
    savePhases,
    deleteAllPhases,
  };
};
