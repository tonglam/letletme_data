import { createPlayerOperations } from 'domains/player/operation';
import { PlayerCache, PlayerOperations } from 'domains/player/types';
import { pipe } from 'fp-ts/function';
import * as RA from 'fp-ts/ReadonlyArray';
import * as TE from 'fp-ts/TaskEither';
import { FplBootstrapDataService } from 'src/data/types';
import { PlayerCreateInputs, PlayerRepository } from 'src/repositories/player/type';
import { Player, PlayerId, Players } from 'src/types/domain/player.type';
import { TeamId } from 'src/types/domain/team.type';
import {
  createDomainError,
  DataLayerError,
  DomainErrorCode,
  ServiceError,
} from 'src/types/error.type';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'src/utils/error.util';

import { PlayerService, PlayerServiceOperations } from './types';

const playerServiceOperations = (
  fplDataService: FplBootstrapDataService,
  domainOps: PlayerOperations,
  cache: PlayerCache,
): PlayerServiceOperations => ({
  findAllPlayers: (): TE.TaskEither<ServiceError, Players> =>
    pipe(cache.getAllPlayers(), TE.mapLeft(mapDomainErrorToServiceError)),

  findPlayerById: (element: PlayerId): TE.TaskEither<ServiceError, Player> =>
    pipe(
      cache.getAllPlayers(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chainOptionK(() =>
        mapDomainErrorToServiceError(
          createDomainError({
            code: DomainErrorCode.NOT_FOUND,
            message: `Player with ID ${element} not found in cache.`,
          }),
        ),
      )((players) => RA.findFirst((p: Player) => p.element === element)(players)),
    ),

  findPlayerByElementType: (elementType: number): TE.TaskEither<ServiceError, Players> =>
    pipe(
      cache.getAllPlayers(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.map((players) => RA.filter((p: Player) => p.elementType === elementType)(players)),
    ),

  findPlayerByTeam: (team: TeamId): TE.TaskEither<ServiceError, Players> =>
    pipe(
      cache.getAllPlayers(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.map((players) => RA.filter((p: Player) => p.team === team)(players)),
    ),

  syncPlayersFromApi: (): TE.TaskEither<ServiceError, void> =>
    pipe(
      fplDataService.getPlayers(),
      TE.mapLeft((error: DataLayerError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch/map players via data layer',
          cause: error.cause,
          details: error.details,
        }),
      ),
      TE.chainFirstW(() =>
        pipe(domainOps.deleteAllPlayers(), TE.mapLeft(mapDomainErrorToServiceError)),
      ),
      TE.chainW((playerCreateData: PlayerCreateInputs) =>
        pipe(domainOps.savePlayers(playerCreateData), TE.mapLeft(mapDomainErrorToServiceError)),
      ),
      TE.chainFirstW((savedPlayers: Players) =>
        pipe(cache.setAllPlayers(savedPlayers), TE.mapLeft(mapDomainErrorToServiceError)),
      ),
      TE.map(() => void 0),
    ),
});

export const createPlayerService = (
  fplDataService: FplBootstrapDataService,
  repository: PlayerRepository,
  cache: PlayerCache,
): PlayerService => {
  const domainOps = createPlayerOperations(repository);
  const ops = playerServiceOperations(fplDataService, domainOps, cache);

  return {
    getPlayers: (): TE.TaskEither<ServiceError, Players> => ops.findAllPlayers(),
    getPlayer: (id: PlayerId): TE.TaskEither<ServiceError, Player> => ops.findPlayerById(id),
    getPlayerByElementType: (elementType: number): TE.TaskEither<ServiceError, Players> =>
      ops.findPlayerByElementType(elementType),
    getPlayerByTeam: (team: TeamId): TE.TaskEither<ServiceError, Players> =>
      ops.findPlayerByTeam(team),
    syncPlayersFromApi: (): TE.TaskEither<ServiceError, void> => ops.syncPlayersFromApi(),
  };
};
