import { createPlayerOperations } from 'domain/player/operation';
import { PlayerCache, PlayerOperations } from 'domain/player/types';
import { TeamCache } from 'domain/team/types';

import { FplBootstrapDataService } from 'data/types';
import { pipe } from 'fp-ts/function';
import * as RA from 'fp-ts/ReadonlyArray';
import * as TE from 'fp-ts/TaskEither';
import { PlayerRepository } from 'repository/player/types';
import { PlayerService, PlayerServiceOperations } from 'service/player/types';
import { Player, PlayerId, Players, PlayerType, RawPlayers } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';
import { createDomainError, DataLayerError, DomainErrorCode, ServiceError } from 'types/error.type';
import { enrichPlayers } from 'utils/data-enrichment.util';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'utils/error.util';

const playerServiceOperations = (
  fplDataService: FplBootstrapDataService,
  domainOps: PlayerOperations,
  playerCache: PlayerCache,
  teamCache: TeamCache,
): PlayerServiceOperations => {
  const findPlayerById = (id: PlayerId): TE.TaskEither<ServiceError, Player> =>
    pipe(
      playerCache.getAllPlayers(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chainOptionK(() =>
        mapDomainErrorToServiceError(
          createDomainError({
            code: DomainErrorCode.NOT_FOUND,
            message: `Player with ID ${id} not found in cache.`,
          }),
        ),
      )((players) => RA.findFirst((p: Player) => p.id === id)(players)),
    );

  const findPlayersByElementType = (
    elementType: PlayerType,
  ): TE.TaskEither<ServiceError, Players> =>
    pipe(
      playerCache.getAllPlayers(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.map((players) => RA.filter((p: Player) => p.type === elementType)(players)),
    );

  const findPlayersByTeamId = (teamId: TeamId): TE.TaskEither<ServiceError, Players> =>
    pipe(
      playerCache.getAllPlayers(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.map((players) => RA.filter((p: Player) => p.teamId === teamId)(players)),
    );

  const findAllPlayers = (): TE.TaskEither<ServiceError, Players> =>
    pipe(playerCache.getAllPlayers(), TE.mapLeft(mapDomainErrorToServiceError));

  const syncPlayersFromApi = (): TE.TaskEither<ServiceError, void> =>
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
      TE.chainW((rawPlayers: RawPlayers) =>
        pipe(
          rawPlayers.length > 0 ? domainOps.savePlayers(rawPlayers) : TE.right([] as RawPlayers),
          TE.mapLeft(mapDomainErrorToServiceError),
        ),
      ),
      TE.chainW((savedRawPlayers: RawPlayers) =>
        pipe(enrichPlayers(teamCache)(savedRawPlayers), TE.mapLeft(mapDomainErrorToServiceError)),
      ),
      TE.chainW((enrichedPlayers: Players) =>
        pipe(
          enrichedPlayers.length > 0
            ? playerCache.setAllPlayers(enrichedPlayers)
            : TE.rightIO(() => {}),
          TE.mapLeft(mapDomainErrorToServiceError),
        ),
      ),
      TE.map(() => undefined),
    );

  return {
    findPlayerById,
    findPlayersByElementType,
    findPlayersByTeam: findPlayersByTeamId,
    findAllPlayers,
    syncPlayersFromApi,
  };
};

export const createPlayerService = (
  fplDataService: FplBootstrapDataService,
  repository: PlayerRepository,
  playerCache: PlayerCache,
  teamCache: TeamCache,
): PlayerService => {
  const domainOps = createPlayerOperations(repository);
  const ops = playerServiceOperations(fplDataService, domainOps, playerCache, teamCache);

  return {
    getPlayer: (id: PlayerId): TE.TaskEither<ServiceError, Player> => ops.findPlayerById(id),
    getPlayersByElementType: (elementType: PlayerType): TE.TaskEither<ServiceError, Players> =>
      ops.findPlayersByElementType(elementType),
    getPlayersByTeamId: (teamId: TeamId): TE.TaskEither<ServiceError, Players> =>
      ops.findPlayersByTeam(teamId),
    getPlayers: (): TE.TaskEither<ServiceError, Players> => ops.findAllPlayers(),
    syncPlayersFromApi: (): TE.TaskEither<ServiceError, void> => ops.syncPlayersFromApi(),
  };
};
