import { createPlayerOperations } from 'domains/player/operation';
import { PlayerCache, PlayerOperations, PlayerRepository } from 'domains/player/types';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { FplBootstrapDataService } from 'src/data/types';
import { PrismaPlayerCreate } from 'src/repositories/player/type';
import { Player, PlayerId, Players } from 'src/types/domain/player.type';
import { DataLayerError, ServiceError } from 'src/types/error.type';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'src/utils/error.util';
import { PlayerService, PlayerServiceOperations } from './types';

const playerServiceOperations = (
  domainOps: PlayerOperations,
  fplDataService: FplBootstrapDataService,
): PlayerServiceOperations => ({
  findAllPlayers: () =>
    pipe(domainOps.getAllPlayers(), TE.mapLeft(mapDomainErrorToServiceError)) as TE.TaskEither<
      ServiceError,
      Players
    >,

  findPlayerById: (id: PlayerId) =>
    pipe(domainOps.getPlayerById(id), TE.mapLeft(mapDomainErrorToServiceError)) as TE.TaskEither<
      ServiceError,
      Player | null
    >,

  syncPlayersFromApi: () =>
    pipe(
      fplDataService.getPlayers(),
      TE.mapLeft((error: DataLayerError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch/map players via data layer',
          cause: error.cause,
          details: error.details,
        }),
      ),
      TE.map((rawData) => mapRawDataToPlayerCreateArray(rawData)),
      TE.chain((playerCreateData) =>
        pipe(domainOps.savePlayers(playerCreateData), TE.mapLeft(mapDomainErrorToServiceError)),
      ),
    ) as TE.TaskEither<ServiceError, Players>,
});

const mapRawDataToPlayerCreateArray = (rawData: Players): PrismaPlayerCreate[] => {
  return rawData.map((player) => player as PrismaPlayerCreate);
};

export const createPlayerService = (
  fplDataService: FplBootstrapDataService,
  repository: PlayerRepository,
  cache: PlayerCache,
): PlayerService => {
  const domainOps = createPlayerOperations(repository, cache);
  const ops = playerServiceOperations(domainOps, fplDataService);

  return {
    getPlayers: () => ops.findAllPlayers(),
    getPlayer: (id: PlayerId) => ops.findPlayerById(id),
    syncPlayersFromApi: () => ops.syncPlayersFromApi(),
  };
};
