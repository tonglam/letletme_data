import { EventCache } from 'domains/event/types';
import { createPlayerStatOperations } from 'domains/player-stat/operation';
import { PlayerStatCache, PlayerStatOperations } from 'domains/player-stat/types';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { PlayerStatService, PlayerStatServiceOperations } from 'services/player-stat/types';
import { FplBootstrapDataService } from 'src/data/types';
import { PlayerStatRepository } from 'src/repositories/player-stat/type';
import { PlayerStat, PlayerStats } from 'src/types/domain/player-stat.type';
import {
  DataLayerError,
  DomainError,
  DomainErrorCode,
  ServiceError,
  ServiceErrorCode,
  createDomainError,
  createServiceError,
} from 'src/types/error.type';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'src/utils/error.util';

const playerStatServiceOperations = (
  fplDataService: FplBootstrapDataService,
  domainOps: PlayerStatOperations,
  playerStatCache: PlayerStatCache,
  eventCache: EventCache,
): PlayerStatServiceOperations => ({
  findPlayerStat: (element: number): TE.TaskEither<ServiceError, PlayerStat> =>
    pipe(
      playerStatCache.getAllPlayerStats(),
      TE.mapLeft((error: DomainError) => {
        return mapDomainErrorToServiceError(error);
      }),
      TE.chainOptionK(() =>
        mapDomainErrorToServiceError(
          createDomainError({
            code: DomainErrorCode.NOT_FOUND,
            message: `Player stat with element ${element} not found in cache after fetching all.`,
          }),
        ),
      )((playerStats) =>
        O.fromNullable(playerStats.find((playerStat) => playerStat.element === element)),
      ),
    ),

  findPlayerStatsByElementType: (elementType: number): TE.TaskEither<ServiceError, PlayerStats> =>
    pipe(
      playerStatCache.getAllPlayerStats(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.map((playerStats) =>
        playerStats.filter((playerStat) => playerStat.elementType === elementType),
      ),
    ),

  findPlayerStatsByTeam: (team: number): TE.TaskEither<ServiceError, PlayerStats> =>
    pipe(
      playerStatCache.getAllPlayerStats(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.map((playerStats) => playerStats.filter((playerStat) => playerStat.team === team)),
    ),

  findAllPlayerStats: (): TE.TaskEither<ServiceError, PlayerStats> =>
    pipe(playerStatCache.getAllPlayerStats(), TE.mapLeft(mapDomainErrorToServiceError)),

  syncPlayerStatsFromApi: (): TE.TaskEither<ServiceError, void> =>
    pipe(
      eventCache.getCurrentEvent(),
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
      TE.chainW((event) =>
        pipe(
          fplDataService.getPlayerStats(event),
          TE.map((stats) => ({ event, stats })),
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
        pipe(
          domainOps.savePlayerStats(mappedStats),
          TE.mapLeft(mapDomainErrorToServiceError),
          TE.map(() => undefined),
        ),
      ),
    ),
});

export const createPlayerStatService = (
  fplDataService: FplBootstrapDataService,
  repository: PlayerStatRepository,
  playerStatCache: PlayerStatCache,
  eventCache: EventCache,
): PlayerStatService => {
  const domainOps = createPlayerStatOperations(repository);
  const ops = playerStatServiceOperations(fplDataService, domainOps, playerStatCache, eventCache);

  return {
    getPlayerStat: (element: number): TE.TaskEither<ServiceError, PlayerStat> =>
      ops.findPlayerStat(element),
    getPlayerStatsByElementType: (elementType: number): TE.TaskEither<ServiceError, PlayerStats> =>
      ops.findPlayerStatsByElementType(elementType),
    getPlayerStatsByTeam: (team: number): TE.TaskEither<ServiceError, PlayerStats> =>
      ops.findPlayerStatsByTeam(team),
    getPlayerStats: (): TE.TaskEither<ServiceError, PlayerStats> => ops.findAllPlayerStats(),
    syncPlayerStatsFromApi: (): TE.TaskEither<ServiceError, void> => ops.syncPlayerStatsFromApi(),
  };
};
