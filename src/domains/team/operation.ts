import { TeamOperations } from 'domains/team/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { TeamCreateInputs, TeamRepository } from 'src/repositories/team/type';
import { createDomainError, DomainErrorCode } from 'src/types/error.type';
import { getErrorMessage } from 'src/utils/error.util';

export const createTeamOperations = (repository: TeamRepository): TeamOperations => ({
  saveTeams: (teams: TeamCreateInputs) =>
    pipe(
      repository.saveBatch(teams),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveBatch): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    ),

  deleteAllTeams: () =>
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
