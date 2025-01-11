import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { DomainError } from '../../../types/error.type';
import { Player, PlayerId, Players } from '../../../types/player.type';
import type { PlayerRepository } from '../../../types/player/repository.type';
import { handleDomainError } from '../../../utils/error.util';

export interface PlayerCommandOperations {
  readonly getPlayerById: (id: PlayerId) => TE.TaskEither<DomainError, Player | null>;
  readonly createPlayers: (players: Players) => TE.TaskEither<DomainError, Players>;
  readonly deleteAll: () => TE.TaskEither<DomainError, void>;
}

export const createPlayerCommandOperations = (
  repository: PlayerRepository,
): PlayerCommandOperations => ({
  getPlayerById: (id: PlayerId) =>
    pipe(repository.findById(id), TE.mapLeft(handleDomainError('Failed to fetch player'))),

  createPlayers: (players: Players) =>
    pipe(repository.saveBatch(players), TE.mapLeft(handleDomainError('Failed to create players'))),

  deleteAll: () =>
    pipe(repository.deleteAll(), TE.mapLeft(handleDomainError('Failed to delete all players'))),
});
