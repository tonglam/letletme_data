import { createPlayerStatOperations } from 'domains/player-stat/operation';
import {
  PlayerStatCache,
  PlayerStatOperations,
  PlayerStatRepository,
} from 'domains/player-stat/types';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { EventService } from 'services/event/types';
import { PlayerStatService, PlayerStatServiceOperations } from 'services/player-stat/types';
import { FplBootstrapDataService } from 'src/data/types';
import { PrismaPlayerStatCreate } from 'src/repositories/player-stat/type';
import { PlayerStat, PlayerStatId, PlayerStats } from 'src/types/domain/player-stat.type';
import {
  DataLayerError,
  ServiceError,
  ServiceErrorCode,
  createServiceError,
} from 'src/types/error.type';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'src/utils/error.util';

const playerStatServiceOperations = (
  domainOps: PlayerStatOperations,
  fplDataService: FplBootstrapDataService,
  eventService: EventService,
): PlayerStatServiceOperations => ({
  findAllPlayerStats: () =>
    pipe(domainOps.getAllPlayerStats(), TE.mapLeft(mapDomainErrorToServiceError)) as TE.TaskEither<
      ServiceError,
      PlayerStats
    >,

  findPlayerStatById: (id: PlayerStatId) =>
    pipe(
      domainOps.getPlayerStatById(id),
      TE.mapLeft(mapDomainErrorToServiceError),
    ) as TE.TaskEither<ServiceError, PlayerStat | null>,

  syncPlayerStatsFromApi: () =>
    pipe(
      eventService.getCurrentEvent(),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.OPERATION_ERROR,
          message: 'Failed to fetch current event',
          cause: error.cause,
        }),
      ),
      TE.chainW((event) =>
        event
          ? TE.right(event.id)
          : TE.left(
              createServiceError({
                code: ServiceErrorCode.OPERATION_ERROR,
                message: 'No current event found to sync player stats for.',
              }),
            ),
      ),
      TE.chainW((eventId) => fplDataService.getPlayerStats(eventId)),
      TE.mapLeft((error: DataLayerError | ServiceError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch/map player stats via data layer',
          cause: error.cause,
          details: error.details,
        }),
      ),
      TE.map((rawData: readonly Omit<PlayerStat, 'id'>[]) =>
        mapRawDataToPlayerStatCreateArray(rawData),
      ),
      TE.chain((playerStatCreateData) =>
        pipe(
          domainOps.savePlayerStats(playerStatCreateData),
          TE.mapLeft(mapDomainErrorToServiceError),
        ),
      ),
    ),
});

const mapRawDataToPlayerStatCreateArray = (
  rawData: readonly Omit<PlayerStat, 'id'>[],
): PrismaPlayerStatCreate[] => {
  return rawData.map((playerStat) => playerStat as PrismaPlayerStatCreate);
};

export const createPlayerStatService = (
  fplDataService: FplBootstrapDataService,
  repository: PlayerStatRepository,
  cache: PlayerStatCache,
  eventService: EventService,
): PlayerStatService => {
  const domainOps = createPlayerStatOperations(repository, cache);
  const ops = playerStatServiceOperations(domainOps, fplDataService, eventService);

  return {
    getPlayerStats: () => ops.findAllPlayerStats(),
    getPlayerStat: (id: PlayerStatId) => ops.findPlayerStatById(id),
    syncPlayerStatsFromApi: () => ops.syncPlayerStatsFromApi(),
  };
};
