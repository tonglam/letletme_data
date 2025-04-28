import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import { Option } from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { TournamentBattleGroupResultRepository } from 'repository/tournament-battle-group-result/types';
import {
  TournamentBattleGroupResultService,
  TournamentBattleGroupResultServiceOperations,
} from 'service/tournament-battle-group-result/types';
import { TournamentBattleGroupResults } from 'types/domain/tournament-battle-group-result.type';
import { TournamentId } from 'types/domain/tournament-info.type';
import { createDomainError, DomainErrorCode, ServiceError } from 'types/error.type';
import { mapDomainErrorToServiceError, mapDBErrorToServiceError } from 'utils/error.util';

const tournamentBattleGroupResultServiceOperations = (
  repository: TournamentBattleGroupResultRepository,
): TournamentBattleGroupResultServiceOperations => {
  const findBattleGroupResultsByTournamentId = (
    id: TournamentId,
  ): TE.TaskEither<ServiceError, TournamentBattleGroupResults> =>
    pipe(
      repository.findByTournamentId(id),
      TE.mapLeft(mapDBErrorToServiceError),
      TE.chainOptionK<ServiceError>(
        (): ServiceError =>
          mapDomainErrorToServiceError(
            createDomainError({
              code: DomainErrorCode.NOT_FOUND,
              message: `TournamentEntry with ID ${id} not found.`,
            }),
          ),
      )(
        (tournamentBattleGroupResults): Option<TournamentBattleGroupResults> =>
          O.fromNullable(tournamentBattleGroupResults),
      ),
    );

  return {
    findBattleGroupResultsByTournamentId,
  };
};

export const createTournamentBattleGroupResultService = (
  repository: TournamentBattleGroupResultRepository,
): TournamentBattleGroupResultService => {
  const ops = tournamentBattleGroupResultServiceOperations(repository);

  return {
    getBattleGroupResultsByTournamentId: (
      id: TournamentId,
    ): TE.TaskEither<ServiceError, TournamentBattleGroupResults> =>
      ops.findBattleGroupResultsByTournamentId(id),
  };
};
