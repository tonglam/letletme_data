import * as TE from 'fp-ts/TaskEither';
import { TournamentService, TournamentServiceOperations } from 'services/tournament/types';
import { TournamentId } from 'types/domain/tournament-info.type';
import { ServiceError } from 'types/error.type';

const tournamentServiceOperations = (): TournamentServiceOperations => {
  const drawTournamentGroups = (id: TournamentId): TE.TaskEither<ServiceError, void> => {
    return TE.right(undefined);
  };

  const drawTournamentKnockouts = (id: TournamentId): TE.TaskEither<ServiceError, void> => {
    return TE.right(undefined);
  };

  const initializeTournament = (id: TournamentId): TE.TaskEither<ServiceError, void> => {
    return TE.right(undefined);
  };

  return {
    drawTournamentGroups,
    drawTournamentKnockouts,
    initializeTournament,
  };
};

export const createTournamentService = (): TournamentService => {
  const ops = tournamentServiceOperations();

  return {
    drawTournamentGroups: (id: TournamentId): TE.TaskEither<ServiceError, void> =>
      ops.drawTournamentGroups(id),
    drawTournamentKnockouts: (id: TournamentId): TE.TaskEither<ServiceError, void> =>
      ops.drawTournamentKnockouts(id),
    initializeTournament: (id: TournamentId): TE.TaskEither<ServiceError, void> =>
      ops.initializeTournament(id),
  };
};
