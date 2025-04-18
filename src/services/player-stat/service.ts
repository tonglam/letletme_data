import { createPlayerStatOperations } from 'domains/player-stat/operation';
import {
  PlayerStatCache,
  PlayerStatOperations,
  PlayerStatRepository,
} from 'domains/player-stat/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { EventService } from 'services/event/types';
import { PlayerStatService, PlayerStatServiceOperations } from 'services/player-stat/types';
import { FplBootstrapDataService } from 'src/data/types';
import { mapDomainStatToPrismaCreateInput } from 'src/repositories/player-stat/mapper';
import { PrismaPlayerStatCreateInput } from 'src/repositories/player-stat/type';
import { PlayerStat, PlayerStatId, PlayerStats } from 'src/types/domain/player-stat.type';
import {
  DataLayerError,
  DomainError,
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
      TE.mapLeft((error: DomainError) => {
        return mapDomainErrorToServiceError(error);
      }),
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
      TE.chainW((eventId) =>
        pipe(
          fplDataService.getPlayerStats(eventId),
          TE.map((stats) => ({ eventId, stats })),
        ),
      ),
      TE.mapLeft((error: DataLayerError | ServiceError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch/map player stats via data layer',
          cause: error.cause,
          details: error.details,
        }),
      ),
      TE.map(({ eventId, stats }) => ({
        eventId,
        mappedStats: mapRawDataToPlayerStatCreateArray(stats),
      })),
      TE.chainW(({ eventId, mappedStats }) =>
        pipe(
          domainOps.deletePlayerStatsByEventId(eventId),
          TE.mapLeft(mapDomainErrorToServiceError),
          TE.map(() => mappedStats),
        ),
      ),
      TE.chain((mappedStats) =>
        pipe(domainOps.savePlayerStats(mappedStats), TE.mapLeft(mapDomainErrorToServiceError)),
      ),
    ),
});

const mapRawDataToPlayerStatCreateArray = (
  rawData: readonly Omit<PlayerStat, 'id'>[],
): PrismaPlayerStatCreateInput[] => {
  return rawData.map(mapDomainStatToPrismaCreateInput);
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
