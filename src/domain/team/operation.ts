import { TeamOperations } from 'domain/team/types';

import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { TeamCreateInputs, TeamRepository } from 'repository/team/types';
import { Teams } from 'types/domain/team.type';
import { createDomainError, DomainError, DomainErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createTeamOperations = (repository: TeamRepository): TeamOperations => {
  const saveTeams = (teamInputs: TeamCreateInputs): TE.TaskEither<DomainError, Teams> =>
    pipe(
      repository.saveBatch(teamInputs),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveBatch): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  const deleteAllTeams = (): TE.TaskEither<DomainError, void> =>
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
    saveTeams,
    deleteAllTeams,
  };
};
