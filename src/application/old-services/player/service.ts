import { PlayerCache } from 'domain/player/types';
import { TeamCache } from 'domain/team/types';

import { FplBootstrapDataService } from 'data/types';
import { pipe } from 'fp-ts/function';
import * as RA from 'fp-ts/ReadonlyArray';
import * as TE from 'fp-ts/TaskEither';
import { PlayerRepository } from 'repository/player/types';
import { PlayerService, PlayerServiceOperations } from 'service/player/types';
import { ElementTypeId } from 'types/base.type';
import { Player, PlayerId, Players, RawPlayers } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';
import { CacheErrorCode, createCacheError, ServiceError } from 'types/error.type';
import { enrichPlayers } from 'utils/data-enrichment.util';
import {
  mapCacheErrorToServiceError,
  mapDataLayerErrorToServiceError,
  mapDBErrorToServiceError,
} from 'utils/error.util';

const playerServiceOperations = (
  fplDataService: FplBootstrapDataService,
  repository: PlayerRepository,
  cache: PlayerCache,
  teamCache: TeamCache,
): PlayerServiceOperations => {
  const findPlayerById = (id: PlayerId): TE.TaskEither<ServiceError, Player> =>
    pipe(
      cache.getAllPlayers(),
      TE.mapLeft(mapCacheErrorToServiceError),
      TE.chainOptionK(() =>
        mapCacheErrorToServiceError(
          createCacheError({
            code: CacheErrorCode.NOT_FOUND,
            message: `Player with ID ${id} not found in cache.`,
          }),
        ),
      )((players) => RA.findFirst((p: Player) => p.id === id)(players)),
    );

  const findPlayersByElementType = (
    elementType: ElementTypeId,
  ): TE.TaskEither<ServiceError, Players> =>
    pipe(
      cache.getAllPlayers(),
      TE.mapLeft(mapCacheErrorToServiceError),
      TE.map((players) => RA.filter((p: Player) => p.type === elementType)(players)),
    );

  const findPlayersByTeamId = (teamId: TeamId): TE.TaskEither<ServiceError, Players> =>
    pipe(
      cache.getAllPlayers(),
      TE.mapLeft(mapCacheErrorToServiceError),
      TE.map((players) => RA.filter((p: Player) => p.teamId === teamId)(players)),
    );

  const findAllPlayers = (): TE.TaskEither<ServiceError, Players> =>
    pipe(cache.getAllPlayers(), TE.mapLeft(mapCacheErrorToServiceError));

  const syncPlayersFromApi = (): TE.TaskEither<ServiceError, void> =>
    pipe(
      fplDataService.getPlayers(),
      TE.mapLeft(mapDataLayerErrorToServiceError),
      TE.chainFirstW(() => pipe(repository.deleteAll(), TE.mapLeft(mapDBErrorToServiceError))),
      TE.chainW((rawPlayers: RawPlayers) =>
        pipe(
          rawPlayers.length > 0 ? repository.saveBatch(rawPlayers) : TE.right([] as RawPlayers),
          TE.mapLeft(mapDBErrorToServiceError),
        ),
      ),
      TE.chainW((savedRawPlayers: RawPlayers) =>
        pipe(enrichPlayers(teamCache)(savedRawPlayers), TE.mapLeft(mapCacheErrorToServiceError)),
      ),
      TE.chainW((enrichedPlayers: Players) =>
        pipe(
          enrichedPlayers.length > 0 ? cache.setAllPlayers(enrichedPlayers) : TE.rightIO(() => {}),
          TE.mapLeft(mapCacheErrorToServiceError),
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
  cache: PlayerCache,
  teamCache: TeamCache,
): PlayerService => {
  const ops = playerServiceOperations(fplDataService, repository, cache, teamCache);

  return {
    getPlayer: (id: PlayerId): TE.TaskEither<ServiceError, Player> => ops.findPlayerById(id),
    getPlayersByElementType: (elementType: ElementTypeId): TE.TaskEither<ServiceError, Players> =>
      ops.findPlayersByElementType(elementType),
    getPlayersByTeamId: (teamId: TeamId): TE.TaskEither<ServiceError, Players> =>
      ops.findPlayersByTeam(teamId),
    getPlayers: (): TE.TaskEither<ServiceError, Players> => ops.findAllPlayers(),
    syncPlayersFromApi: (): TE.TaskEither<ServiceError, void> => ops.syncPlayersFromApi(),
  };
};
