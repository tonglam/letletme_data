import { EventCache } from 'domain/event/types';
import { PlayerCache } from 'domain/player/types';
import { createPlayerStatOperations } from 'domain/player-stat/operation';
import { PlayerStatCache, PlayerStatOperations } from 'domain/player-stat/types';
import { TeamCache } from 'domain/team/types';

import { FplBootstrapDataService } from 'data/types';
import { pipe, flow } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { PlayerStatRepository } from 'repository/player-stat/types';
import { PlayerStatService, PlayerStatServiceOperations } from 'service/player-stat/types';
import { ElementTypeId } from 'types/base.type';
import { Event } from 'types/domain/event.type';
import { PlayerStat, PlayerStats, RawPlayerStats } from 'types/domain/player-stat.type';
import { PlayerId } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';
import {
  DataLayerError,
  DomainErrorCode,
  ServiceError,
  ServiceErrorCode,
  createDomainError,
  createServiceError,
} from 'types/error.type';
import { enrichPlayerStats } from 'utils/data-enrichment.util';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'utils/error.util';

const playerStatServiceOperations = (
  fplDataService: FplBootstrapDataService,
  domainOps: PlayerStatOperations,
  cache: PlayerStatCache,
  eventCache: EventCache,
  teamCache: TeamCache,
  playerCache: PlayerCache,
): PlayerStatServiceOperations => {
  const findPlayerStat = (elementId: PlayerId): TE.TaskEither<ServiceError, PlayerStat> =>
    pipe(
      cache.getLatestPlayerStats(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chainOptionK(() =>
        mapDomainErrorToServiceError(
          createDomainError({
            code: DomainErrorCode.NOT_FOUND,
            message: `Player stat with element ${elementId} not found in cache.`,
          }),
        ),
      )((playerStats) => O.fromNullable(playerStats.find((stat) => stat.elementId === elementId))),
    );

  const findPlayerStatsByElementType = (
    elementType: ElementTypeId,
  ): TE.TaskEither<ServiceError, PlayerStats> =>
    pipe(
      cache.getLatestPlayerStats(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.map((playerStats) =>
        playerStats.filter((playerStat) => playerStat.elementType === elementType),
      ),
    );

  const findPlayerStatsByTeam = (teamId: TeamId): TE.TaskEither<ServiceError, PlayerStats> =>
    pipe(
      cache.getLatestPlayerStats(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.map((playerStats) => playerStats.filter((playerStat) => playerStat.teamId === teamId)),
    );

  const findPlayerStats = (): TE.TaskEither<ServiceError, PlayerStats> =>
    pipe(
      cache.getLatestPlayerStats(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.orElseW(() =>
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
                ? cache.setLatestPlayerStats(enrichedDbStats)
                : TE.rightIO(() => {}),
              TE.mapLeft(mapDomainErrorToServiceError),
              TE.orElseW((cacheSetError) => {
                console.warn('[findPlayerStats] Cache fallback: Failed to update cache', {
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
          TE.chainW((rawPlayerStats: RawPlayerStats) =>
            pipe(
              rawPlayerStats.length > 0
                ? domainOps.saveLatestPlayerStats(rawPlayerStats)
                : TE.right(rawPlayerStats as RawPlayerStats),
              TE.mapLeft(mapDomainErrorToServiceError),
            ),
          ),
          TE.chainW((savedStats: RawPlayerStats) =>
            pipe(
              enrichPlayerStats(playerCache, teamCache)(savedStats),
              TE.mapLeft(mapDomainErrorToServiceError),
            ),
          ),
          TE.chainW((enrichedPlayerStats: PlayerStats) =>
            pipe(
              enrichedPlayerStats.length > 0
                ? cache.setLatestPlayerStats(enrichedPlayerStats)
                : TE.rightIO(() => {}),
              TE.mapLeft(mapDomainErrorToServiceError),
            ),
          ),
        ),
      ),
      TE.map(() => undefined),
    );

  return {
    findPlayerStat,
    findPlayerStatsByElementType,
    findPlayerStatsByTeam,
    findPlayerStats,
    syncPlayerStatsFromApi,
  };
};

export const createPlayerStatService = (
  fplDataService: FplBootstrapDataService,
  repository: PlayerStatRepository,
  cache: PlayerStatCache,
  eventCache: EventCache,
  teamCache: TeamCache,
  playerCache: PlayerCache,
): PlayerStatService => {
  const domainOps = createPlayerStatOperations(repository);
  const ops = playerStatServiceOperations(
    fplDataService,
    domainOps,
    cache,
    eventCache,
    teamCache,
    playerCache,
  );

  return {
    getPlayerStat: ops.findPlayerStat,
    getPlayerStatsByElementType: ops.findPlayerStatsByElementType,
    getPlayerStatsByTeam: ops.findPlayerStatsByTeam,
    getPlayerStats: ops.findPlayerStats,
    syncPlayerStatsFromApi: ops.syncPlayerStatsFromApi,
  };
};
