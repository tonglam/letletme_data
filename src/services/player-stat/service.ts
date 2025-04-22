import { EventCache } from 'domains/event/types';
import { PlayerCache } from 'domains/player/types';
import { createPlayerStatOperations } from 'domains/player-stat/operation';
import { PlayerStatCache, PlayerStatOperations } from 'domains/player-stat/types';
import { TeamCache } from 'domains/team/types';
import { pipe, flow } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { PlayerStatService, PlayerStatServiceOperations } from 'services/player-stat/types';
import { FplBootstrapDataService } from 'src/data/types';
import { PlayerStatRepository } from 'src/repositories/player-stat/type';
import { Event } from 'src/types/domain/event.type';
import { PlayerStat, PlayerStats, SourcePlayerStats } from 'src/types/domain/player-stat.type';
import {
  DataLayerError,
  DomainErrorCode,
  ServiceError,
  ServiceErrorCode,
  createDomainError,
  createServiceError,
} from 'src/types/error.type';
import { enrichPlayerStats } from 'src/utils/data-enrichment.util';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'src/utils/error.util';

const playerStatServiceOperations = (
  fplDataService: FplBootstrapDataService,
  domainOps: PlayerStatOperations,
  playerStatCache: PlayerStatCache,
  eventCache: EventCache,
  playerCache: PlayerCache,
  teamCache: TeamCache,
): PlayerStatServiceOperations => {
  const findPlayerStat = (element: number): TE.TaskEither<ServiceError, PlayerStat> =>
    pipe(
      playerStatCache.getLatestPlayerStats(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chainOptionK(() =>
        mapDomainErrorToServiceError(
          createDomainError({
            code: DomainErrorCode.NOT_FOUND,
            message: `Player stat with element ${element} not found in cache.`,
          }),
        ),
      )((playerStats) => O.fromNullable(playerStats.find((stat) => stat.element === element))),
    );

  const findPlayerStatsByElementType = (
    elementType: number,
  ): TE.TaskEither<ServiceError, PlayerStats> =>
    pipe(
      playerStatCache.getLatestPlayerStats(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.map((playerStats) =>
        playerStats.filter((playerStat) => playerStat.elementType === elementType),
      ),
    );

  const findPlayerStatsByTeam = (team: number): TE.TaskEither<ServiceError, PlayerStats> =>
    pipe(
      playerStatCache.getLatestPlayerStats(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.map((playerStats) => playerStats.filter((playerStat) => playerStat.team === team)),
    );

  const findLatestPlayerStats = (): TE.TaskEither<ServiceError, PlayerStats> =>
    pipe(
      playerStatCache.getLatestPlayerStats(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.orElseW((_cacheError) =>
        pipe(
          domainOps.getLatestPlayerStats(),
          TE.mapLeft(mapDomainErrorToServiceError),
          TE.chainW(
            flow(
              enrichPlayerStats(playerCache, teamCache),
              TE.mapLeft(mapDomainErrorToServiceError),
            ),
          ),
          TE.chainFirstW((enrichedDbStats) =>
            pipe(
              enrichedDbStats.length > 0
                ? playerStatCache.setLatestPlayerStats(enrichedDbStats)
                : TE.rightIO(() => {}),
              TE.mapLeft(mapDomainErrorToServiceError),
              TE.orElseW((cacheSetError) => {
                console.warn('[findLatestPlayerStats] Cache fallback: Failed to update cache', {
                  error: cacheSetError,
                });
                return TE.rightIO(() => {});
              }),
            ),
          ),
        ),
      ),
    );

  const syncPlayerStatsFromApi = (): TE.TaskEither<ServiceError, void> =>
    pipe(
      eventCache.getCurrentEvent(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chainW((event: Event) =>
        event
          ? TE.right(event)
          : TE.left(
              createServiceError({
                code: ServiceErrorCode.OPERATION_ERROR,
                message: 'No current event found',
              }),
            ),
      ),
      TE.chainW((event: Event) =>
        pipe(
          fplDataService.getPlayerStats(event.id),
          TE.mapLeft((error: DataLayerError) =>
            createServiceIntegrationError({ message: 'Failed to fetch FPL stats', cause: error }),
          ),
          TE.chainFirstW(() =>
            pipe(domainOps.deleteLatestPlayerStats(), TE.mapLeft(mapDomainErrorToServiceError)),
          ),
          TE.chainW((sourcePlayerStats) =>
            pipe(
              sourcePlayerStats.length > 0
                ? domainOps.saveLatestPlayerStats(sourcePlayerStats)
                : TE.right(sourcePlayerStats as SourcePlayerStats),
              TE.mapLeft(mapDomainErrorToServiceError),
            ),
          ),
          TE.chainW((savedStats: SourcePlayerStats) =>
            pipe(
              enrichPlayerStats(playerCache, teamCache)(savedStats),
              TE.mapLeft(mapDomainErrorToServiceError),
            ),
          ),
          TE.chainW((enrichedPlayerStats: PlayerStats) =>
            pipe(
              enrichedPlayerStats.length > 0
                ? playerStatCache.setLatestPlayerStats(enrichedPlayerStats)
                : TE.rightIO(() => {}),
              TE.mapLeft(mapDomainErrorToServiceError),
            ),
          ),
        ),
      ),
      TE.map(() => void 0),
    );

  return {
    findPlayerStat,
    findPlayerStatsByElementType,
    findPlayerStatsByTeam,
    findLatestPlayerStats,
    syncPlayerStatsFromApi,
  };
};

export const createPlayerStatService = (
  fplDataService: FplBootstrapDataService,
  repository: PlayerStatRepository,
  playerStatCache: PlayerStatCache,
  eventCache: EventCache,
  playerCache: PlayerCache,
  teamCache: TeamCache,
): PlayerStatService => {
  const domainOps = createPlayerStatOperations(repository);
  const ops = playerStatServiceOperations(
    fplDataService,
    domainOps,
    playerStatCache,
    eventCache,
    playerCache,
    teamCache,
  );

  return {
    getPlayerStat: ops.findPlayerStat,
    getPlayerStatsByElementType: ops.findPlayerStatsByElementType,
    getPlayerStatsByTeam: ops.findPlayerStatsByTeam,
    getLatestPlayerStats: ops.findLatestPlayerStats,
    syncPlayerStatsFromApi: ops.syncPlayerStatsFromApi,
  };
};
